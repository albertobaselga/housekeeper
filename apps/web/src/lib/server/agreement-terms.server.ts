import type { Pool, PoolClient } from 'pg';

import type { AgreementCreateInputV1, AgreementTermsInputV1 } from '@casa-clara/contracts';
import { AuthorizationError, createLogger, errorCode, withAuthorizedTransaction } from '@casa-clara/server';

import {
  buildExtraWorkTypeView,
  buildScheduleView,
  buildSupplementView,
  currentLocalDate,
  dateLabel,
  formatCents,
  readVacationCarryoverExpiry,
  vacationCarryoverExpiryLabel,
  weeklyHoursLabel,
  type ExtraWorkTypeRow,
  type ExtraWorkTypeView,
  type RecurringSupplementRow,
  type ScheduleDayRow,
  type ScheduleRow,
  type ScheduleView,
  type SupplementView,
  type VacationCarryoverExpiry
} from '$lib/employment/model';
import { unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';

const log = createLogger('web:agreement-terms');

/**
 * Alta y edición del acuerdo laboral desde la interfaz de administración.
 *
 * Hasta aquí los acuerdos solo entraban por datos de prueba: la aplicación
 * sabía LEER un expediente que nadie podía crear desde dentro. Este módulo
 * cierra ese hueco con el invariante de siempre, y sin excepciones: nunca se
 * reescribe una versión. Editar las condiciones es APILAR una versión nueva con
 * su catálogo entero, y el historial enseña las dos, una debajo de la otra.
 *
 * Por qué no pasa por la cola offline: pactar condiciones laborales es un acto
 * deliberado, no una anotación que pueda quedarse esperando red y aplicarse
 * media hora después sobre un estado distinto. Se hace contra el servidor o no
 * se hace. Es la misma decisión que la pantalla de ajustes toma para el cambio
 * de contraseña.
 */

export interface AgreementVersionAdminView {
  id: string;
  versionNumber: number;
  effectiveFrom: string;
  effectiveFromLabel: string;
  /** Crudo, para prellenar el formulario sin deshacer un formato. */
  monthlySalaryCents: string;
  salaryLabel: string;
  weeklyMinutes: number;
  weeklyLabel: string;
  annualVacationDays: number;
  /**
   * Crudo y nullable: null significa «no se pactó», y la pantalla lo dice con
   * esas palabras. Un 0 aquí sería un precio acordado de cero euros por día.
   */
  unusedVacationDayRateCents: string | null;
  /** null cuando no se pactó. Nunca «0,00 €». */
  unusedVacationDayRateLabel: string | null;
  vacationCarryoverExpiry: VacationCarryoverExpiry;
  vacationCarryoverExpiryLabel: string;
  reason: string;
  /** vigente hoy / entra en vigor más adelante / histórica. */
  state: 'vigente' | 'futura' | 'historica';
  extraWorkTypes: ExtraWorkTypeView[];
  supplements: SupplementView[];
  /** null = esta versión no declara horario. Se puede pactar uno apilando otra. */
  schedule: ScheduleView | null;
}

export interface AgreementAdminView {
  id: string;
  employeeMembershipId: string;
  employeeName: string;
  status: string;
  startsOn: string;
  startsOnLabel: string;
  endsOn: string | null;
  versions: AgreementVersionAdminView[];
}

/**
 * Alguien con acceso a la casa y sin contrato en vigor. Son dos historias
 * distintas y no se deciden igual: la que se dio de alta sin pactar contrato
 * ACABA DE LLEGAR, y aquella cuyo contrato terminó VUELVE a la casa. Por eso la
 * fila lleva la distinción y no sólo el nombre.
 */
export interface EmployeeCandidateView {
  membershipId: string;
  name: string;
  /** Fin del último contrato en esta casa, o null si nunca tuvo ninguno. */
  previousEndedOn: string | null;
  /** true = vuelve a la casa; false = acaba de llegar. */
  returning: boolean;
}

export interface AgreementAdminOverview {
  householdId: string;
  today: string;
  agreements: AgreementAdminView[];
  /** Empleadas internas del hogar que todavía no tienen acuerdo activo. */
  candidates: EmployeeCandidateView[];
}

interface AgreementRow {
  id: string;
  employeeMembershipId: string;
  employeeName: string | null;
  status: string;
  startsOn: string;
  endsOn: string | null;
}

interface VersionRow {
  id: string;
  agreementId: string;
  versionNumber: number;
  effectiveFrom: string;
  monthlySalaryCents: string;
  contractedWeeklyMinutes: number;
  annualVacationDays: number;
  unusedVacationDayRateCents: string | null;
  terms: unknown;
  reason: string;
}

type CatalogueRow = ExtraWorkTypeRow & { agreementId: string };
type SupplementCatalogueRow = RecurringSupplementRow & { agreementId: string };
type ScheduleCatalogueRow = ScheduleRow & { agreementId: string };

/**
 * Empleadas internas sin acuerdo activo. El modelo admite varios acuerdos vivos
 * en el mismo hogar —uno por persona—, así que esta lista puede tener más de un
 * nombre a la vez.
 *
 * Vive suelta y no dentro de `loadAgreementAdmin` porque la piden TRES sitios:
 * la portada del hogar (que las lista para pactar su contrato), el alta (que
 * entra directa en la etapa del contrato cuando la persona ya existe) y la
 * propia vista de administración. Tenerla escrita tres veces garantizaba que un
 * día se afinara en una y no en las otras.
 *
 * El LATERAL con agregados devuelve siempre una fila, así que `total` nunca
 * llega nulo.
 */
export async function readEmployeeCandidates(
  client: PoolClient,
  householdId: string
): Promise<EmployeeCandidateView[]> {
  const result = await client.query<{
    membershipId: string;
    name: string | null;
    previousCount: string;
    previousEndedOn: string | null;
  }>(
    `select membership.id as "membershipId",
            profile.display_name as "name",
            previo.total::text as "previousCount",
            previo.ended_on::text as "previousEndedOn"
       from app.household_memberships as membership
       left join app.user_profiles as profile on profile.user_id = membership.user_id
       left join lateral (
         select count(*) as total, max(agreement.ends_on) as ended_on
           from app.employment_agreements as agreement
          where agreement.household_id = membership.household_id
            and agreement.employee_membership_id = membership.id
       ) as previo on true
      where membership.household_id = $1
        and membership.role = 'employee_live_in'
        and membership.revoked_at is null
        and not exists (
          select 1 from app.employment_agreements as agreement
           where agreement.household_id = membership.household_id
             and agreement.employee_membership_id = membership.id
             and agreement.status = 'active'
        )
      order by profile.display_name nulls last, membership.id`,
    [householdId]
  );
  return result.rows.map((row) => ({
    membershipId: row.membershipId,
    name: row.name ?? 'Empleada sin nombre en el perfil',
    previousEndedOn: row.previousEndedOn,
    returning: Number(row.previousCount) > 0
  }));
}

/**
 * Lo mínimo que necesita la pantalla del alta: la fecha de hoy para las fechas
 * por omisión y las personas que ya están en la casa sin contrato. No trae los
 * acuerdos ni sus versiones porque el alta no los pinta.
 */
export async function loadHireContext(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool(),
  now: Date = new Date()
): Promise<{ today: string; candidates: EmployeeCandidateView[] } | null> {
  if (!pool) return null;
  const today = currentLocalDate(now);
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      if (membership.role !== 'family_admin') return null;
      return { today, candidates: await readEmployeeCandidates(client, householdId) };
    });
  } catch (cause) {
    return unreadable(log, 'hire context', cause);
  }
}

async function readAgreements(client: PoolClient, householdId: string): Promise<AgreementRow[]> {
  const result = await client.query<AgreementRow>(
    `select agreement.id,
            agreement.employee_membership_id as "employeeMembershipId",
            profile.display_name as "employeeName",
            agreement.status::text as "status",
            agreement.starts_on::text as "startsOn",
            agreement.ends_on::text as "endsOn"
       from app.employment_agreements as agreement
       join app.household_memberships as membership
         on membership.household_id = agreement.household_id
        and membership.id = agreement.employee_membership_id
       left join app.user_profiles as profile on profile.user_id = membership.user_id
      where agreement.household_id = $1
      order by (agreement.status = 'active') desc, agreement.starts_on desc`,
    [householdId]
  );
  return result.rows;
}

/**
 * Expediente de administración del acuerdo. Devuelve null cuando no hay base de
 * datos o quien pregunta no administra el hogar: el gate de rol es
 * deliberadamente redundante con la RLS, porque esta vista o es completa —con
 * los conceptos desactivados y los que aún no tienen tarifa, que hay que poder
 * editar— o no sirve para nada.
 */
export async function loadAgreementAdmin(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool(),
  now: Date = new Date()
): Promise<AgreementAdminOverview | null> {
  if (!pool) return null;
  const today = currentLocalDate(now);
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      if (membership.role !== 'family_admin') return null;

      const agreements = await readAgreements(client, householdId);
      const agreementIds = agreements.map((row) => row.id);

      const empty = { rows: [] };
      const versions = agreementIds.length
        ? await client.query<VersionRow>(
            `select id,
                    agreement_id as "agreementId",
                    version_number as "versionNumber",
                    effective_from::text as "effectiveFrom",
                    monthly_salary_cents::text as "monthlySalaryCents",
                    contracted_weekly_minutes as "contractedWeeklyMinutes",
                    annual_vacation_days as "annualVacationDays",
                    unused_vacation_day_rate_cents::text as "unusedVacationDayRateCents",
                    terms,
                    reason
               from app.agreement_versions
              where household_id = $1 and agreement_id = any($2::uuid[])
              order by agreement_id, version_number desc`,
            [householdId, agreementIds]
          )
        : empty;

      const types = agreementIds.length
        ? await client.query<CatalogueRow>(
            `select id,
                    agreement_id as "agreementId",
                    agreement_version_id as "agreementVersionId",
                    code, name, unit::text as "unit",
                    rate_cents::text as "rateCents",
                    reference_minutes as "referenceMinutes",
                    active
               from app.extra_work_types
              where household_id = $1 and agreement_id = any($2::uuid[])
              order by sort_order, code`,
            [householdId, agreementIds]
          )
        : empty;

      const supplements = agreementIds.length
        ? await client.query<SupplementCatalogueRow>(
            `select id,
                    agreement_id as "agreementId",
                    agreement_version_id as "agreementVersionId",
                    code, name,
                    amount_cents::text as "amountCents",
                    periodicity::text as "periodicity",
                    adds_to_pay as "addsToPay",
                    starts_on::text as "startsOn",
                    ends_on::text as "endsOn",
                    active
               from app.recurring_supplements
              where household_id = $1 and agreement_id = any($2::uuid[])
              order by sort_order, code`,
            [householdId, agreementIds]
          )
        : empty;

      // Horario de cada versión (0025). Una versión puede no tener ninguno:
      // esta pantalla enseña ese hueco tal cual, porque es lo que la empleada
      // verá —o mejor dicho, lo que NO verá— y quien administra tiene que
      // saberlo antes de pactar.
      const schedules = agreementIds.length
        ? await client.query<ScheduleCatalogueRow>(
            `select id,
                    agreement_id as "agreementId",
                    agreement_version_id as "agreementVersionId",
                    to_char(starts_at, 'HH24:MI') as "startsAt",
                    to_char(ends_at, 'HH24:MI') as "endsAt",
                    long_break_minutes as "longBreakMinutes",
                    note
               from app.agreement_schedules
              where household_id = $1 and agreement_id = any($2::uuid[])`,
            [householdId, agreementIds]
          )
        : empty;

      const scheduleDays = agreementIds.length
        ? await client.query<ScheduleDayRow>(
            `select id,
                    schedule_id as "scheduleId",
                    weekday,
                    works,
                    to_char(starts_at, 'HH24:MI') as "startsAt",
                    to_char(ends_at, 'HH24:MI') as "endsAt",
                    long_break_minutes as "longBreakMinutes",
                    note
               from app.agreement_schedule_days
              where household_id = $1 and agreement_id = any($2::uuid[])
              order by weekday`,
            [householdId, agreementIds]
          )
        : empty;

      const candidates = await readEmployeeCandidates(client, householdId);

      const byAgreement = new Map<string, AgreementVersionAdminView[]>();
      for (const version of versions.rows) {
        const later = versions.rows.filter(
          (candidate) =>
            candidate.agreementId === version.agreementId &&
            candidate.effectiveFrom <= today &&
            candidate.effectiveFrom > version.effectiveFrom
        );
        const state: AgreementVersionAdminView['state'] =
          version.effectiveFrom > today ? 'futura' : later.length > 0 ? 'historica' : 'vigente';
        // Ausente en `terms` son seis meses: las versiones anteriores a la 0034
        // no la pactaron y esa es la política que se les venía aplicando.
        const carryoverExpiry = readVacationCarryoverExpiry(version.terms);
        const list = byAgreement.get(version.agreementId) ?? [];
        list.push({
          id: version.id,
          versionNumber: version.versionNumber,
          effectiveFrom: version.effectiveFrom,
          effectiveFromLabel: dateLabel(version.effectiveFrom),
          monthlySalaryCents: version.monthlySalaryCents,
          salaryLabel: formatCents(version.monthlySalaryCents),
          weeklyMinutes: version.contractedWeeklyMinutes,
          weeklyLabel: weeklyHoursLabel(version.contractedWeeklyMinutes),
          annualVacationDays: version.annualVacationDays,
          unusedVacationDayRateCents: version.unusedVacationDayRateCents,
          // null y no «0,00 €»: no se pactó no es lo mismo que se pactó cero.
          unusedVacationDayRateLabel:
            version.unusedVacationDayRateCents === null
              ? null
              : formatCents(version.unusedVacationDayRateCents),
          vacationCarryoverExpiry: carryoverExpiry,
          vacationCarryoverExpiryLabel: vacationCarryoverExpiryLabel(carryoverExpiry),
          reason: version.reason,
          state,
          extraWorkTypes: types.rows
            .filter((row) => row.agreementVersionId === version.id)
            .map(buildExtraWorkTypeView),
          supplements: supplements.rows
            .filter((row) => row.agreementVersionId === version.id)
            .map(buildSupplementView),
          schedule: (() => {
            const row = schedules.rows.find(
              (candidate) => candidate.agreementVersionId === version.id
            );
            return row
              ? buildScheduleView({
                  schedule: row,
                  days: scheduleDays.rows,
                  contractedWeeklyMinutes: version.contractedWeeklyMinutes
                })
              : null;
          })()
        });
        byAgreement.set(version.agreementId, list);
      }

      return {
        householdId,
        today,
        agreements: agreements.map((row) => ({
          id: row.id,
          employeeMembershipId: row.employeeMembershipId,
          employeeName: row.employeeName ?? 'Empleada',
          status: row.status,
          startsOn: row.startsOn,
          startsOnLabel: dateLabel(row.startsOn),
          endsOn: row.endsOn,
          versions: byAgreement.get(row.id) ?? []
        })),
        candidates
      } satisfies AgreementAdminOverview;
    });
  } catch (cause) {
    return unreadable(log, 'agreement admin', cause);
  }
}

export type TermsWriteResult =
  | { ok: true; agreementId: string; versionId: string }
  | { ok: false; message: string };

/**
 * Escribe una versión y su catálogo. No hay ruta de actualización a propósito:
 * `app.agreement_versions` y las dos tablas del catálogo solo admiten INSERT
 * (disparadores de 0002 y 0021), así que ni este código ni ningún otro puede
 * reescribir lo pactado aunque lo intente.
 *
 * Las columnas reliquia `overtime_hourly_rate_cents` y
 * `worked_rest_day_rate_cents` se escriben con la tarifa de los conceptos
 * equivalentes cuando existen y con 0 cuando no. Siguen ahí por compatibilidad
 * (ver el pie de 0021) y hay que dejarlas coherentes: un lector antiguo tiene
 * que ver un número que no contradiga al catálogo, no uno heredado de otra
 * versión.
 */
async function insertVersion(
  client: PoolClient,
  householdId: string,
  agreementId: string,
  versionNumber: number,
  actorMembershipId: string,
  terms: AgreementTermsInputV1
): Promise<string> {
  const hourly = terms.extraWorkTypes.find((type) => type.unit === 'per_hour' && type.active);
  const shift = terms.extraWorkTypes.find((type) => type.unit !== 'per_hour' && type.active);
  const creditMinutes = shift?.referenceMinutes ?? 1440;

  const inserted = await client.query<{ id: string }>(
    `insert into app.agreement_versions
       (household_id, agreement_id, version_number, effective_from, monthly_salary_cents,
        overtime_hourly_rate_cents, worked_rest_day_rate_cents, worked_rest_day_credit_minutes,
        contracted_weekly_minutes, annual_vacation_days, unused_vacation_day_rate_cents,
        terms, reason, created_by_membership_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             coalesce((select previa.terms
                         from app.agreement_versions as previa
                        where previa.household_id = $1 and previa.agreement_id = $2
                        order by previa.version_number desc
                        limit 1), '{}'::jsonb) || $12::jsonb,
             $13, $14)
     returning id`,
    [
      householdId,
      agreementId,
      versionNumber,
      terms.effectiveFrom,
      terms.monthlySalaryCents,
      hourly?.rateCents ?? '0',
      shift?.rateCents ?? '0',
      creditMinutes,
      terms.contractedWeeklyMinutes,
      terms.annualVacationDays,
      // null de verdad, nunca '0': la columna de la 0034 es NULLABLE porque
      // «no se pactó» y «se pactó cero» son cosas distintas y la fila es
      // inmutable, así que un cero por omisión no se podría corregir jamás.
      terms.unusedVacationDayRateCents,
      // `terms` deja de ser el `{}` que nadie escribía: aquí entra la política
      // de caducidad de los días arrastrados, con la forma que la CHECK de la
      // 0034 admite y el esquema zod valida.
      //
      // Se MEZCLA sobre los términos de la versión anterior (el `||` de arriba),
      // no se reemplaza el jsonb entero. Hoy da igual porque sólo hay una clave,
      // pero el día que entre una segunda —vacaciones tiene tarea abierta— un
      // escritor que reemplace la borraría al apilar, y la fila es inmutable: se
      // perdería sin poder corregirse. La regla es conservar lo que no se
      // escribe, que es la que ya sigue el comando de vacaciones.
      JSON.stringify({ vacationCarryoverExpiry: terms.vacationCarryoverExpiry }),
      terms.reason,
      actorMembershipId
    ]
  );
  const versionId = inserted.rows[0]?.id;
  if (!versionId) throw new Error('La inserción de la versión no devolvió identificador');

  let order = 0;
  for (const type of terms.extraWorkTypes) {
    order += 10;
    await client.query(
      `insert into app.extra_work_types
         (household_id, agreement_id, agreement_version_id, code, name, unit, rate_cents,
          reference_minutes, active, sort_order, created_by_membership_id)
       values ($1, $2, $3, $4, $5, $6::app.extra_work_unit, $7, $8, $9, $10, $11)`,
      [
        householdId,
        agreementId,
        versionId,
        type.code,
        type.name,
        type.unit,
        type.rateCents,
        type.referenceMinutes,
        type.active,
        order,
        actorMembershipId
      ]
    );
  }

  order = 0;
  for (const supplement of terms.supplements) {
    order += 10;
    await client.query(
      `insert into app.recurring_supplements
         (household_id, agreement_id, agreement_version_id, code, name, amount_cents,
          periodicity, adds_to_pay, starts_on, ends_on, active, sort_order,
          created_by_membership_id)
       values ($1, $2, $3, $4, $5, $6, $7::app.supplement_periodicity, $8, $9, $10, $11, $12, $13)`,
      [
        householdId,
        agreementId,
        versionId,
        supplement.code,
        supplement.name,
        supplement.amountCents,
        supplement.periodicity,
        supplement.addsToPay,
        supplement.startsOn,
        supplement.endsOn,
        supplement.active,
        order,
        actorMembershipId
      ]
    );
  }

  /*
   * El horario, si esta versión declara uno. `terms.schedule === null` no
   * escribe nada, y esa ausencia es la respuesta completa: la vista de la
   * empleada no enseñará sección de horario.
   *
   * Ojo con lo que eso significa al apilar: una versión nueva sin horario RETIRA
   * el horario a partir de su fecha, igual que un concepto que se deja fuera del
   * catálogo deja de existir a partir de ella. Por eso el formulario parte
   * siempre del horario vigente en vez de empezar en blanco.
   */
  if (terms.schedule) {
    const insertedSchedule = await client.query<{ id: string }>(
      `insert into app.agreement_schedules
         (household_id, agreement_id, agreement_version_id, starts_at, ends_at,
          long_break_minutes, note, created_by_membership_id)
       values ($1, $2, $3, $4::time, $5::time, $6, $7, $8)
       returning id`,
      [
        householdId,
        agreementId,
        versionId,
        terms.schedule.startsAt,
        terms.schedule.endsAt,
        terms.schedule.longBreakMinutes,
        terms.schedule.note,
        actorMembershipId
      ]
    );
    const scheduleId = insertedSchedule.rows[0]?.id;
    if (!scheduleId) throw new Error('La inserción del horario no devolvió identificador');

    for (const day of terms.schedule.days) {
      await client.query(
        `insert into app.agreement_schedule_days
           (household_id, agreement_id, schedule_id, weekday, works, starts_at, ends_at,
            long_break_minutes, note, created_by_membership_id)
         values ($1, $2, $3, $4, $5, $6::time, $7::time, $8, $9, $10)`,
        [
          householdId,
          agreementId,
          scheduleId,
          day.weekday,
          day.works,
          day.startsAt,
          day.endsAt,
          day.longBreakMinutes,
          day.note,
          actorMembershipId
        ]
      );
    }
  }

  return versionId;
}

/**
 * Traduce el rechazo del esquema a algo que una persona pueda corregir, EN
 * CASTELLANO.
 *
 * Devolver `issue.message` en crudo escribía «Invalid input: expected number,
 * received NaN» en una pantalla que está en castellano hasta el último
 * `aria-label`, y además no decía qué campo ni qué hacer. Se traduce por el
 * primer tramo de la ruta, que es el nombre del campo: la regla la sigue
 * decidiendo zod, aquí sólo se le pone nombre, igual que `explain` hace con los
 * códigos de Postgres.
 */
export function explainTermsIssue(issue: { path: PropertyKey[] } | undefined): string {
  switch (issue?.path[0]) {
    case 'effectiveFrom':
      return 'La fecha de entrada en vigor no es una fecha válida.';
    case 'monthlySalaryCents':
      return 'El salario mensual no es un importe válido.';
    case 'contractedWeeklyMinutes':
      return 'La jornada semanal tiene que ser un número de minutos entre 1 y 10.080.';
    case 'annualVacationDays':
      return 'Los días de vacaciones al año tienen que ser un número entre 0 y 365.';
    case 'unusedVacationDayRateCents':
      return 'El precio del día de vacaciones no disfrutado no es un importe válido.';
    case 'vacationCarryoverExpiry':
      return 'Di qué pasa con los días arrastrados: o caducan pasados unos meses (entre 1 y 120), o no expiran nunca.';
    case 'reason':
      return 'Escribe por qué se pacta así: el motivo es obligatorio y queda en el historial.';
    case 'extraWorkTypes':
      return 'Revisa el catálogo de trabajo extra: cada concepto necesita código, nombre y, si se paga por jornada, de cuántos minutos es.';
    case 'supplements':
      return 'Revisa los complementos: cada uno necesita código, nombre y quién lo cobra, y su vigencia no puede acabar antes de empezar.';
    case 'schedule':
      return 'Revisa el horario: la jornada no puede terminar antes de empezar y el descanso tiene que caber dentro.';
    case 'employeeMembershipId':
      return 'No hemos entendido de quién es este contrato. Vuelve a la lista de personas y elígela otra vez.';
    case 'startsOn':
      return 'La fecha de inicio del contrato no es una fecha válida.';
    default:
      return 'Hay algún dato de las condiciones que no es válido. Revísalos e inténtalo otra vez.';
  }
}

/**
 * Traduce el fallo de Postgres a algo que una persona pueda corregir. Los
 * códigos vienen de los disparadores y CHECK de 0002, 0021 y 0025, que son
 * quienes mandan: aquí no se duplica ninguna regla, solo se le pone nombre.
 */
export function explain(cause: unknown): string {
  const code = (cause as { code?: string }).code;
  if (code === '23505') {
    return 'Ya hay una versión con esa fecha de entrada en vigor, o dos conceptos comparten código, o un día de la semana aparece dos veces en el horario.';
  }
  if (code === '23514') {
    return 'Una versión nueva tiene que entrar en vigor DESPUÉS de la última. Revisa también que cada jornada diga de cuántas horas es y que ningún día del horario termine antes de empezar.';
  }
  if (code === '55000') {
    return 'Lo pactado no se reescribe: para cambiarlo hay que añadir una versión nueva.';
  }
  return 'No hemos podido guardar las condiciones. Revisa los datos e inténtalo otra vez.';
}

/**
 * Escribe el acuerdo y su primera versión sobre un cliente que YA está dentro
 * de una transacción autorizada. Existe suelta para que el alta de personal
 * pueda meter la cuenta, la membresía y el contrato en la MISMA transacción:
 * dar de alta a alguien con acceso y sin contrato por un fallo a medio camino
 * sería un estado que luego hay que ir a arreglar a mano.
 *
 * No comprueba el papel de quien escribe: eso lo hace quien abre la
 * transacción, y por debajo la RLS (`agreements_admin_insert`).
 */
export async function insertAgreementWithFirstVersion(
  client: PoolClient,
  householdId: string,
  actorMembershipId: string,
  input: AgreementCreateInputV1
): Promise<{ agreementId: string; versionId: string }> {
  const created = await client.query<{ id: string }>(
    `insert into app.employment_agreements
       (household_id, employee_membership_id, starts_on, created_by_membership_id)
     values ($1, $2, $3, $4)
     returning id`,
    [householdId, input.employeeMembershipId, input.startsOn, actorMembershipId]
  );
  const agreementId = created.rows[0]?.id;
  if (!agreementId) throw new Error('El alta del acuerdo no devolvió identificador');
  const versionId = await insertVersion(
    client,
    householdId,
    agreementId,
    1,
    actorMembershipId,
    input.terms
  );
  return { agreementId, versionId };
}

/** Alta del acuerdo y de su primera versión, en la misma transacción. */
export async function createAgreement(
  user: { id: string },
  householdId: string,
  input: AgreementCreateInputV1,
  pool: Pool | null = getDatabasePool()
): Promise<TermsWriteResult> {
  if (!pool) return { ok: false, message: 'Este entorno no tiene base de datos.' };
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      if (membership.role !== 'family_admin') {
        return { ok: false, message: 'Solo quien administra el hogar puede dar de alta un acuerdo.' };
      }
      if (input.terms.effectiveFrom < input.startsOn) {
        return {
          ok: false,
          message: 'La primera versión no puede entrar en vigor antes del inicio del acuerdo.'
        };
      }
      /*
       * UN CONTRATO SÓLO EXISTE SOBRE UNA EMPLEADA INTERNA. No lo impedía nada
       * —ni una CHECK, ni la RLS, ni este código—, así que un identificador de
       * membresía de apoyo del hogar o de visor colado en un campo oculto creaba
       * un acuerdo de pleno derecho, y con él una línea en la lista de personas
       * empleadas. El diseño dice literalmente que el apoyo del hogar «no genera
       * contrato ni línea en esta lista», y esto es lo que lo cumple.
       *
       * La comprobación va aquí, en el único sitio por el que pasan las dos
       * puertas, y no en la pantalla: la pantalla ya lo dice con palabras, pero
       * las palabras no son una reja.
       */
      const empleada = await client.query<{ role: string }>(
        `select role::text as "role"
           from app.household_memberships
          where household_id = $1 and id = $2 and revoked_at is null`,
        [householdId, input.employeeMembershipId]
      );
      const role = empleada.rows[0]?.role;
      if (role === undefined) {
        return {
          ok: false,
          message: 'Esa persona no está dada de alta en este hogar, o ya no tiene acceso.'
        };
      }
      if (role !== 'employee_live_in') {
        return {
          ok: false,
          message:
            'Sólo una empleada interna tiene contrato. El apoyo del hogar no genera contrato ni aparece en la lista de personas empleadas.'
        };
      }
      const { agreementId, versionId } = await insertAgreementWithFirstVersion(
        client,
        householdId,
        membership.id,
        input
      );
      return { ok: true, agreementId, versionId };
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('agreement creation failed', { code: errorCode(cause) });
    }
    const code = (cause as { code?: string }).code;
    if (code === '23505') {
      return { ok: false, message: 'Esa persona ya tiene un acuerdo activo en este hogar.' };
    }
    return { ok: false, message: explain(cause) };
  }
}

/**
 * Apila una versión nueva sobre un acuerdo existente. El número de versión se
 * calcula dentro de la transacción; si dos administradores lo intentan a la vez,
 * el disparador `agreement_versions_append_only` de 0002 rechaza a quien llegue
 * con el número o la fecha equivocados.
 */
export async function stackAgreementVersion(
  user: { id: string },
  householdId: string,
  agreementId: string,
  terms: AgreementTermsInputV1,
  pool: Pool | null = getDatabasePool()
): Promise<TermsWriteResult> {
  if (!pool) return { ok: false, message: 'Este entorno no tiene base de datos.' };
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      if (membership.role !== 'family_admin') {
        return { ok: false, message: 'Solo quien administra el hogar puede cambiar las condiciones.' };
      }
      const latest = await client.query<{ versionNumber: number; effectiveFrom: string }>(
        `select version_number as "versionNumber", effective_from::text as "effectiveFrom"
           from app.agreement_versions
          where household_id = $1 and agreement_id = $2
          order by version_number desc
          limit 1`,
        [householdId, agreementId]
      );
      const previous = latest.rows[0];
      if (!previous) {
        return { ok: false, message: 'Ese acuerdo no existe o no es visible en este hogar.' };
      }
      if (terms.effectiveFrom <= previous.effectiveFrom) {
        return {
          ok: false,
          message: `La versión nueva tiene que entrar en vigor después del ${dateLabel(previous.effectiveFrom)}: lo ya pactado no se reescribe.`
        };
      }
      const versionId = await insertVersion(
        client,
        householdId,
        agreementId,
        previous.versionNumber + 1,
        membership.id,
        terms
      );
      return { ok: true, agreementId, versionId };
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('agreement version stacking failed', { code: errorCode(cause) });
    }
    return { ok: false, message: explain(cause) };
  }
}
