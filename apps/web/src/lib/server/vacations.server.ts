import type { Pool } from 'pg';

import { vacationNewsSince, type VacationEventInput } from '@casa-clara/domain';
import { AuthorizationError, createLogger, errorCode, withAuthorizedTransaction } from '@casa-clara/server';

import {
  buildVacationPersonView,
  type VacationHistoryPeriodRow,
  type VacationPersonView
} from '$lib/employment/vacation-history';
import { currentLocalDate, vacationRangeLabel } from '$lib/employment/model';
import { getDatabasePool } from './db.server';

const log = createLogger('web:vacations');

/**
 * Vacaciones completas: TODOS los años y TODAS las personas que la RLS deja
 * ver, no solo el año en curso ni el primer contrato del hogar.
 *
 * Vive en su propio módulo y no dentro de `employment.server.ts` por dos
 * razones que no son de estilo:
 *
 *  · El expediente carga UN contrato —el elegido— con su mes, sus jornadas y
 *    sus cuentas. El historial de vacaciones carga LO CONTRARIO: pocas columnas
 *    de todos los contratos y de todos los años. Mezclar las dos consultas
 *    obligaría a una de las dos a pedir de más.
 *  · Es una ruta propia y por tanto un trozo de JavaScript propio, que la
 *    pantalla de Hoy no importa nunca.
 *
 * Sobre el hogar con varias empleadas: aquí se enseñan todas las que la RLS
 * devuelva. Para quien administra son todas; para la empleada es la suya, sin
 * que este código tenga que filtrar nada —lo hace Postgres—. Es la diferencia
 * con la tarjeta del contrato, que enseña una y se cambia con el selector.
 */

export interface VacationNewsView {
  /** Cuántas novedades hay desde la última vez que miró. 0 = nada que contar. */
  count: number;
  /** «Te han apuntado vacaciones del 1 al 15 de agosto de 2026». */
  headline: string;
  /** Segunda línea con el resto, o null si solo hay una novedad. */
  detail: string | null;
  /**
   * Marca de agua que hay que guardar cuando lo vea: el sello más reciente de
   * lo que se le ha enseñado, no `now()`.
   */
  seenThrough: string | null;
}

export interface VacationOverview {
  householdId: string;
  /** Hoy en la zona del hogar. */
  today: string;
  /** Una tarjeta por contrato visible, la propia primero. */
  people: VacationPersonView[];
  /** Novedades de la persona que mira, si es la empleada del contrato. */
  news: VacationNewsView | null;
}

interface PeriodRow extends VacationHistoryPeriodRow {
  agreementId: string;
  recordedAt: Date;
  voidedAt: Date | null;
}

/**
 * Las novedades en una frase.
 *
 * Un periodo se nombra entero («del 1 al 15 de agosto»); varios se cuentan,
 * porque enumerar cuatro rangos en la pantalla de Hoy es una lista, no un
 * aviso. Lo anulado se dice aparte y sin rodeos: que unas vacaciones que ya
 * tenía apuntadas hayan desaparecido es exactamente lo que hay que contar.
 */
export function buildVacationNews(
  periods: readonly VacationEventInput[],
  seenThrough: string | null
): VacationNewsView | null {
  const news = vacationNewsSince(periods, seenThrough);
  if (news.count === 0) return null;

  const recorded = news.recorded;
  const voided = news.voided;
  const headline =
    recorded.length === 1 && voided.length === 0
      ? `Te han apuntado vacaciones: ${vacationRangeLabel(
          recorded[0]!.startsOn,
          recorded[0]!.endsOn
        ).toLocaleLowerCase('es')}`
      : recorded.length > 0
        ? `Te han apuntado vacaciones nuevas: ${recorded.length} periodos`
        : voided.length === 1
          ? `Se han anulado unas vacaciones que tenías apuntadas: ${vacationRangeLabel(
              voided[0]!.startsOn,
              voided[0]!.endsOn
            ).toLocaleLowerCase('es')}`
          : `Se han anulado ${voided.length} periodos de vacaciones que tenías apuntados`;

  const detail =
    recorded.length > 0 && voided.length > 0
      ? voided.length === 1
        ? 'Además se ha anulado un periodo que ya tenías apuntado.'
        : `Además se han anulado ${voided.length} periodos que ya tenías apuntados.`
      : null;

  return { count: news.count, headline, detail, seenThrough: news.newestAt };
}

/**
 * Historial completo de vacaciones bajo RLS. Devuelve null solo sin pool (demo
 * sin base de datos) o sin membresía viva en el hogar: no hay versión de
 * maqueta de esta pantalla, porque enseñar vacaciones inventadas de una persona
 * real sería peor que no enseñar nada.
 */
export async function loadVacationOverview(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool(),
  now: Date = new Date()
): Promise<VacationOverview | null> {
  if (!pool) return null;
  const today = currentLocalDate(now);

  try {
    return await withAuthorizedTransaction(
      pool,
      { userId: user.id },
      householdId,
      async (client, membership) => {
        const agreements = await client.query<{
          id: string;
          employeeMembershipId: string;
          employeeName: string | null;
          startsOn: string;
          endsOn: string | null;
        }>(
          `select agreement.id,
                  agreement.employee_membership_id as "employeeMembershipId",
                  profile.display_name as "employeeName",
                  agreement.starts_on::text as "startsOn",
                  agreement.ends_on::text as "endsOn"
             from app.employment_agreements as agreement
             left join app.household_memberships as employee
               on employee.household_id = agreement.household_id
              and employee.id = agreement.employee_membership_id
             left join app.user_profiles as profile
               on profile.user_id = employee.user_id
            where agreement.household_id = $1
            order by (agreement.status = 'active') desc, agreement.starts_on desc`,
          [householdId]
        );
        if (agreements.rows.length === 0) {
          return { householdId, today, people: [], news: null } satisfies VacationOverview;
        }
        const agreementIds = agreements.rows.map((row) => row.id);

        // Solo las dos columnas que hacen falta para el derecho de cada año. El
        // salario y las tarifas no pintan nada en una pantalla de vacaciones y
        // viajarían dentro del JSON de la página.
        const versions = await client.query<{
          agreementId: string;
          effectiveFrom: string;
          annualVacationDays: number;
        }>(
          `select agreement_id as "agreementId",
                  effective_from::text as "effectiveFrom",
                  annual_vacation_days as "annualVacationDays"
             from app.agreement_versions
            where household_id = $1 and agreement_id = any($2::uuid[])
            order by agreement_id, version_number`,
          [householdId, agreementIds]
        );

        // Todos los periodos de todos los años: es justo lo que faltaba. Los
        // anulados vienen también, y se listan como anulados.
        const periods = await client.query<PeriodRow>(
          `select id,
                  agreement_id as "agreementId",
                  starts_on::text as "startsOn",
                  ends_on::text as "endsOn",
                  calendar_days as "calendarDays",
                  note,
                  status::text as "status",
                  void_reason as "voidReason",
                  recorded_at as "recordedAt",
                  voided_at as "voidedAt"
             from app.vacation_periods
            where household_id = $1 and agreement_id = any($2::uuid[])
            order by starts_on desc`,
          [householdId, agreementIds]
        );

        const mark = await client.query<{ seenThrough: Date }>(
          `select seen_through as "seenThrough"
             from app.vacation_notice_marks
            where household_id = $1 and membership_id = $2`,
          [householdId, membership.id]
        );

        const people = agreements.rows.map((agreement) =>
          buildVacationPersonView({
            agreementId: agreement.id,
            employeeLabel: agreement.employeeName?.trim() || 'Empleada del hogar',
            own: agreement.employeeMembershipId === membership.id,
            agreementStartsOn: agreement.startsOn,
            agreementEndsOn: agreement.endsOn,
            versions: versions.rows.filter((row) => row.agreementId === agreement.id),
            periods: periods.rows.filter((row) => row.agreementId === agreement.id),
            today
          })
        );
        // La propia primero: quien entra a mirar sus vacaciones no debería tener
        // que buscarlas debajo de las de otra persona.
        people.sort((left, right) => Number(right.own) - Number(left.own));

        const ownAgreementIds = new Set(
          agreements.rows
            .filter((agreement) => agreement.employeeMembershipId === membership.id)
            .map((agreement) => agreement.id)
        );
        const ownPeriods: VacationEventInput[] = periods.rows
          .filter((row) => ownAgreementIds.has(row.agreementId))
          .map((row) => ({
            startsOn: row.startsOn,
            endsOn: row.endsOn,
            status: row.status,
            recordedAt: row.recordedAt.toISOString(),
            voidedAt: row.voidedAt?.toISOString() ?? null
          }));

        return {
          householdId,
          today,
          people,
          news: buildVacationNews(
            ownPeriods,
            mark.rows[0]?.seenThrough.toISOString() ?? null
          )
        } satisfies VacationOverview;
      }
    );
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('vacation overview unavailable', { code: errorCode(cause) });
    }
    return null;
  }
}

/**
 * «Ya lo he visto», para quien llama y solo para quien llama: la función de la
 * base no acepta membresía. `seenThrough` es el sello más reciente que la
 * pantalla llegó a enseñar; la base lo acota para que nadie pueda silenciar por
 * adelantado lo que le apunten mañana.
 */
export async function markVacationsSeen(
  user: { id: string },
  householdId: string,
  seenThrough: string | null,
  pool: Pool | null = getDatabasePool()
): Promise<string | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client) => {
      const marked = await client.query<{ seenThrough: Date }>(
        'select app.mark_vacations_seen($1::timestamptz) as "seenThrough"',
        [seenThrough]
      );
      return marked.rows[0]?.seenThrough.toISOString() ?? null;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('vacation notice mark not recorded', { code: errorCode(cause) });
    }
    return null;
  }
}
