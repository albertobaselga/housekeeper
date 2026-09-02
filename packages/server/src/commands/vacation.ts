import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { UUID } from "@housekeeper/contracts";
import {
  agreementCommandPayloadSchema,
  vacationCommandPayloadSchema,
} from "@housekeeper/contracts/schemas";
import {
  contractYear,
  contractYearName,
  moneyCents,
  readVacationCarryoverExpiry,
  vacationCarryoverDeadline,
  vacationCompensation,
  vacationYearBalance,
  type ContractYear,
  type PeriodMonth,
  type VacationCompensation,
} from "@housekeeper/domain";

import type { ActiveMembership } from "../database.js";
import { CommandRejectedError, type CommandHandler } from "../sync.js";
import { insertManualAdjustment } from "./manual-adjustment.js";
import { requireAgreement } from "./shared.js";

type RecordPayload = {
  agreementId: UUID;
  startsOn: string;
  endsOn: string;
  note?: string | undefined;
};

type VoidPayload = {
  vacationPeriodId: UUID;
  reason: string;
};

type EntitlementPayload = {
  agreementId: UUID;
  annualVacationDays: number;
  effectiveFrom: string;
  reason: string;
};

type CarryOverPayload = { action: "carry_over"; agreementId: UUID; sourceYearIndex: number };
type CompensatePayload = {
  action: "compensate_carryover";
  agreementId: UUID;
  sourceYearIndex: number;
  period: string;
};
type RejectCarryoverPayload = {
  action: "reject_carryover";
  agreementId: UUID;
  sourceYearIndex: number;
  reason: string;
};
type CarryoverPayload = CarryOverPayload | CompensatePayload | RejectCarryoverPayload;

/**
 * Apunta un periodo de vacaciones disfrutado.
 *
 * Lo que se valida aquí y por qué:
 *
 * · El periodo tiene que caer DENTRO del acuerdo. Unas vacaciones anteriores
 *   al primer día de trabajo no son vacaciones de este acuerdo.
 * · No puede pisar otro periodo ya apuntado. Se comprueba aquí para poder dar
 *   una causa legible, y el disparador de la base lo vuelve a comprobar bajo
 *   cerrojo por si dos altas llegan a la vez.
 *
 * Lo que NO se valida, a propósito: que quepa en el derecho anual. Pasarse de
 * días se permite y el saldo lo enseña en negativo (ver la cabecera de
 * `vacations.ts` en el dominio). Rechazarlo empujaría a no apuntar los días,
 * que es justo lo contrario de tener un expediente.
 */
async function recordVacationPeriod(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: RecordPayload,
): Promise<{ resourceId: UUID }> {
  const agreement = await requireAgreement(client, householdId, payload.agreementId);

  const bounds = await client.query<{ starts_on: string; ends_on: string | null }>(
    `select starts_on::text as starts_on, ends_on::text as ends_on
       from app.employment_agreements
      where household_id = $1 and id = $2`,
    [householdId, payload.agreementId],
  );
  const agreementBounds = bounds.rows[0];
  if (!agreementBounds) {
    throw new CommandRejectedError("agreement_not_found", "El acuerdo no existe o no es visible");
  }
  if (payload.startsOn < agreementBounds.starts_on) {
    throw new CommandRejectedError(
      "vacation_before_agreement",
      `El acuerdo empezó el ${agreementBounds.starts_on}: no puede haber vacaciones antes`,
    );
  }
  if (agreementBounds.ends_on !== null && payload.endsOn > agreementBounds.ends_on) {
    throw new CommandRejectedError(
      "vacation_after_agreement",
      `El acuerdo terminó el ${agreementBounds.ends_on}: no puede haber vacaciones después`,
    );
  }

  // Cerrojo consultivo con el mismo espacio de nombres que usa el disparador,
  // tomado antes de leer para que la comprobación de solape y la inserción no
  // se separen si otra alta del mismo acuerdo llega a la vez.
  await client.query("select pg_advisory_xact_lock(hashtextextended($1::text, 4))", [
    payload.agreementId,
  ]);
  const overlapping = await client.query<{ starts_on: string; ends_on: string }>(
    `select starts_on::text as starts_on, ends_on::text as ends_on
       from app.vacation_periods
      where household_id = $1 and agreement_id = $2
        and status = 'recorded'
        and starts_on <= $4 and ends_on >= $3
      limit 1`,
    [householdId, payload.agreementId, payload.startsOn, payload.endsOn],
  );
  const clash = overlapping.rows[0];
  if (clash) {
    throw new CommandRejectedError(
      "vacation_overlaps",
      `Ya hay vacaciones apuntadas del ${clash.starts_on} al ${clash.ends_on}`,
    );
  }

  const inserted = await client.query<{ id: string }>(
    `insert into app.vacation_periods
       (household_id, agreement_id, employee_membership_id, starts_on, ends_on, note,
        recorded_by_membership_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      householdId,
      payload.agreementId,
      agreement.employeeMembershipId,
      payload.startsOn,
      payload.endsOn,
      payload.note ?? "",
      membership.id,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("La inserción del periodo de vacaciones no devolvió identificador");
  return { resourceId: row.id };
}

/**
 * Anula un periodo mal apuntado. No borra: la fila se queda con quién la anuló,
 * cuándo y por qué, y deja de contar en el saldo. Un periodo inexistente y uno
 * ya anulado colapsan en el mismo rechazo: para el cliente ambos significan
 * «aquí no queda nada que corregir».
 */
async function voidVacationPeriod(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: VoidPayload,
): Promise<{ resourceId: UUID }> {
  const loaded = await client.query<{ id: string; status: string }>(
    `select id, status
       from app.vacation_periods
      where household_id = $1 and id = $2
      for update`,
    [householdId, payload.vacationPeriodId],
  );
  const period = loaded.rows[0];
  if (!period || period.status !== "recorded") {
    throw new CommandRejectedError(
      "vacation_not_recorded",
      period ? "Ese periodo ya estaba anulado" : "El periodo no existe en este hogar",
    );
  }

  await client.query(
    `update app.vacation_periods
        set status = 'voided',
            voided_by_membership_id = $3,
            voided_at = now(),
            void_reason = $4
      where household_id = $1 and id = $2`,
    [householdId, period.id, membership.id, payload.reason],
  );
  return { resourceId: period.id };
}

// ─── El salto de año: qué se hace con los días que no se disfrutaron ─────────

/**
 * La propuesta de un año de contrato ya cerrado, RECALCULADA aquí.
 *
 * Los días, la versión y el importe NO llegan del cliente: si llegaran, quien
 * fabricara la petición a mano elegiría cuántos días se le arrastran y cuánto
 * se le paga. Se recalculan desde los periodos apuntados —que son append-only—
 * y desde las versiones del acuerdo, y se congelan en la fila al decidir. Desde
 * ese momento no vuelven a calcularse nunca: anular en marzo un periodo del año
 * anterior no puede mover una decisión ya tomada.
 */
interface CarryoverProposal {
  employeeMembershipId: UUID;
  year: ContractYear;
  entitledDays: number;
  takenDays: number;
  unusedDays: number;
  /** La versión que fijó el DERECHO del año que se cierra. */
  entitlementVersionId: UUID;
  /** `null` cuando la política pactada dice que nunca expiran. */
  deadlineOn: string | null;
  /** `null` cuando la versión vigente al decidir no pacta el precio del día. */
  compensation: VacationCompensation | null;
}

interface VersionRow {
  id: string;
  effective_from: string;
  annual_vacation_days: number;
  unused_vacation_day_rate_cents: string | null;
  terms: unknown;
}

/** La última versión ya en vigor en `onDate`; la primera si ninguna lo está. */
function versionOn(versions: readonly VersionRow[], onDate: string): VersionRow {
  return versions.filter((version) => version.effective_from <= onDate).at(-1) ?? versions[0]!;
}

async function loadCarryoverProposal(
  client: PoolClient,
  householdId: UUID,
  agreementId: UUID,
  sourceYearIndex: number,
): Promise<CarryoverProposal> {
  const loaded = await client.query<{
    employee_membership_id: string;
    starts_on: string;
    ends_on: string | null;
  }>(
    `select employee_membership_id, starts_on::text as starts_on, ends_on::text as ends_on
       from app.employment_agreements
      where household_id = $1 and id = $2`,
    [householdId, agreementId],
  );
  const agreement = loaded.rows[0];
  if (!agreement) {
    throw new CommandRejectedError("agreement_not_found", "El acuerdo no existe o no es visible");
  }

  // Hoy en la zona del hogar, preguntado a la base: el servidor puede correr en
  // otra zona y un arrastre decidido un 2 de febrero a las 23:30 no puede caer
  // en el año siguiente por el desfase del reloj del proceso.
  const clock = await client.query<{ today: string }>(
    "select (statement_timestamp() at time zone 'Europe/Madrid')::date::text as today",
  );
  const today = clock.rows[0]!.today;

  const year = contractYear(agreement.starts_on, sourceYearIndex);
  if (year.endsOn >= today) {
    throw new CommandRejectedError(
      "vacation_year_not_closed",
      `El ${contractYearName(sourceYearIndex)} termina el ${year.endsOn}: hasta entonces los días se pueden seguir cogiendo`,
    );
  }

  const versionRows = await client.query<VersionRow>(
    `select id, effective_from::text as effective_from, annual_vacation_days,
            unused_vacation_day_rate_cents::text as unused_vacation_day_rate_cents, terms
       from app.agreement_versions
      where household_id = $1 and agreement_id = $2
      order by version_number`,
    [householdId, agreementId],
  );
  const versions = versionRows.rows;
  if (versions.length === 0) {
    throw new CommandRejectedError(
      "no_agreement_version",
      "El acuerdo todavía no tiene ninguna versión con términos",
    );
  }

  // DOS versiones, y no es un descuido: el DERECHO del año que se cierra lo
  // fijó la versión vigente al terminar aquel año —cambiar hoy los días
  // pactados no reescribe un año ya vivido—, y el PRECIO lo fija la vigente
  // HOY, porque el dinero es del mes en que se paga (apartado 4.4 del diseño).
  // La política de caducidad viaja con el derecho: el margen es de esos días.
  const entitlementVersion = versionOn(versions, year.endsOn);
  const pricingVersion = versionOn(versions, today);

  const periods = await client.query<{ startsOn: string; endsOn: string }>(
    `select starts_on::text as "startsOn", ends_on::text as "endsOn"
       from app.vacation_periods
      where household_id = $1 and agreement_id = $2 and status = 'recorded'
        and starts_on <= $4::date and ends_on >= $3::date`,
    [householdId, agreementId, year.startsOn, year.endsOn],
  );

  const balance = vacationYearBalance({
    contractYearIndex: sourceYearIndex,
    annualVacationDays: entitlementVersion.annual_vacation_days,
    agreementStartsOn: agreement.starts_on,
    agreementEndsOn: agreement.ends_on,
    periods: periods.rows,
    asOf: today,
  });
  if (balance.remainingDays <= 0) {
    throw new CommandRejectedError(
      "vacation_nothing_to_carry",
      `En el ${contractYearName(sourceYearIndex)} no quedaron días sin disfrutar`,
    );
  }

  const rate = pricingVersion.unused_vacation_day_rate_cents;
  return {
    employeeMembershipId: agreement.employee_membership_id,
    year,
    entitledDays: balance.entitledDays,
    takenDays: balance.takenDays,
    unusedDays: balance.remainingDays,
    entitlementVersionId: entitlementVersion.id,
    deadlineOn: vacationCarryoverDeadline(
      year.endsOn,
      readVacationCarryoverExpiry(entitlementVersion.terms),
    ),
    compensation: vacationCompensation({
      dayRateCents: rate === null ? null : moneyCents(BigInt(rate)),
      rateEffectiveFrom: pricingVersion.effective_from,
      unusedDays: balance.remainingDays,
    }),
  };
}

/**
 * Decide qué pasa con los días sin disfrutar de un año de contrato cerrado:
 * arrastrarlos, pagarlos o perderlos con su motivo.
 *
 * La fila se escribe AQUÍ y sólo aquí: la propuesta se calcula al leer y no
 * existe hasta que alguien decide. Por eso el estado final se inserta de una
 * vez, sin pasar por 'proposed'.
 *
 * El cerrojo consultivo del espacio 6 se toma ANTES de mirar si el año ya está
 * decidido, para que dos administradores a la vez no vean los dos «sin decidir»
 * y generen dos pagos por los mismos días. La restricción única de la 0037 es la
 * otra mitad de esa garantía: si el cerrojo faltara, seguiría sin haber dos
 * filas, sólo que la segunda fallaría con un error feo en vez de con este.
 */
async function decideVacationCarryover(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: CarryoverPayload,
): Promise<{ resourceId: UUID }> {
  await requireAgreement(client, householdId, payload.agreementId);
  await client.query("select pg_advisory_xact_lock(hashtextextended($1::text, 6))", [
    `${payload.agreementId}:${payload.sourceYearIndex}`,
  ]);

  const already = await client.query<{ id: string; status: string }>(
    `select id, status::text as status
       from app.vacation_carryovers
      where household_id = $1 and agreement_id = $2 and source_year_index = $3`,
    [householdId, payload.agreementId, payload.sourceYearIndex],
  );
  const decided = already.rows[0];
  if (decided) {
    throw new CommandRejectedError(
      "vacation_carryover_decided",
      `Los días del ${contractYearName(payload.sourceYearIndex)} ya se decidieron`,
    );
  }

  const proposal = await loadCarryoverProposal(
    client,
    householdId,
    payload.agreementId,
    payload.sourceYearIndex,
  );

  // El identificador se genera aquí porque las dos filas se nombran la una a la
  // otra: el concepto nace apuntando a un arrastre que todavía no existe, y la
  // clave ajena aplazada de la 0037 lo comprueba al COMMIT.
  const carryoverId = randomUUID();
  let manualAdjustmentId: string | null = null;

  if (payload.action === "compensate_carryover") {
    if (proposal.compensation === null) {
      throw new CommandRejectedError(
        "vacation_day_rate_not_agreed",
        "El contrato no pacta cuánto vale un día de vacaciones no disfrutado: pactadlo en las condiciones y entonces se podrá compensar",
      );
    }
    const concept = await insertManualAdjustment(client, membership, householdId, {
      agreementId: payload.agreementId,
      period: payload.period as PeriodMonth,
      label: `Vacaciones del ${contractYearName(payload.sourceYearIndex)} no disfrutadas`,
      reason: proposal.compensation.basis,
      amountCents: proposal.compensation.compensationCents.toString(),
      // Es dinero suyo y se transfiere con la cuenta del mes, como cualquier
      // concepto que suma. Que consten sin moverse es para lo que ya se pagó
      // por otra vía, y esto se paga aquí.
      addsToPay: true,
      vacationCarryoverId: carryoverId,
    });
    manualAdjustmentId = concept.id;
  }

  const status =
    payload.action === "carry_over"
      ? "carried"
      : payload.action === "compensate_carryover"
        ? "compensated"
        : "rejected";

  const inserted = await client.query<{ id: string }>(
    `insert into app.vacation_carryovers
       (id, household_id, agreement_id, employee_membership_id,
        source_year_index, source_year_starts_on, source_year_ends_on,
        entitled_days, taken_days, unused_days, agreement_version_id,
        compensation_cents, compensation_basis, deadline_on,
        status, decided_by_membership_id, decided_at, decision_reason,
        manual_adjustment_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, now(), $17, $18)
     returning id`,
    [
      carryoverId,
      householdId,
      payload.agreementId,
      proposal.employeeMembershipId,
      payload.sourceYearIndex,
      proposal.year.startsOn,
      proposal.year.endsOn,
      proposal.entitledDays,
      proposal.takenDays,
      proposal.unusedDays,
      proposal.entitlementVersionId,
      proposal.compensation?.compensationCents.toString() ?? null,
      proposal.compensation?.basis ?? null,
      proposal.deadlineOn,
      status,
      membership.id,
      payload.action === "reject_carryover" ? payload.reason : null,
      manualAdjustmentId,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("La inserción del arrastre de vacaciones no devolvió identificador");
  return { resourceId: row.id };
}

/**
 * Cambia el derecho anual de vacaciones APILANDO una versión nueva del
 * acuerdo, porque las versiones son inmutables (disparador
 * `agreement_versions_append_only`). El resto de los términos —salario,
 * tarifas, jornada— se copian de la última versión: este comando cambia una
 * cosa y solo una, y el historial de «Versiones y cambios» explica cuál.
 *
 * Nunca retroactivo: reescribir el derecho de un año ya vivido cambiaría
 * saldos que la empleada ya vio.
 */
async function setVacationEntitlement(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: EntitlementPayload,
): Promise<{ resourceId: UUID }> {
  await requireAgreement(client, householdId, payload.agreementId);

  await client.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
    payload.agreementId,
  ]);
  const latest = await client.query<{
    version_number: number;
    effective_from: string;
    monthly_salary_cents: string;
    overtime_hourly_rate_cents: string;
    worked_rest_day_rate_cents: string;
    worked_rest_day_credit_minutes: number;
    contracted_weekly_minutes: number;
    annual_vacation_days: number;
    unused_vacation_day_rate_cents: string | null;
    terms: unknown;
  }>(
    `select version_number, effective_from::text as effective_from,
            monthly_salary_cents::text as monthly_salary_cents,
            overtime_hourly_rate_cents::text as overtime_hourly_rate_cents,
            worked_rest_day_rate_cents::text as worked_rest_day_rate_cents,
            worked_rest_day_credit_minutes, contracted_weekly_minutes,
            annual_vacation_days,
            unused_vacation_day_rate_cents::text as unused_vacation_day_rate_cents,
            terms
       from app.agreement_versions
      where household_id = $1 and agreement_id = $2
      order by version_number desc
      limit 1`,
    [householdId, payload.agreementId],
  );
  const current = latest.rows[0];
  if (!current) {
    throw new CommandRejectedError(
      "no_agreement_version",
      "El acuerdo todavía no tiene ninguna versión con términos",
    );
  }
  if (payload.effectiveFrom <= current.effective_from) {
    throw new CommandRejectedError(
      "retroactive_agreement_version",
      `La versión vigente empezó el ${current.effective_from}: la nueva tiene que entrar en vigor después`,
    );
  }
  if (current.annual_vacation_days === payload.annualVacationDays) {
    throw new CommandRejectedError(
      "vacation_entitlement_unchanged",
      `El acuerdo ya reconoce ${payload.annualVacationDays} días naturales al año`,
    );
  }

  const inserted = await client.query<{ id: string }>(
    // La tarifa del día de vacaciones no disfrutado se COPIA como el resto de
    // lo pactado. Dejarla fuera de esta lista la borraría al apilar la versión,
    // y el contrato pasaría de tener precio a no tenerlo sin que nadie lo
    // decidiera: la pantalla dejaría de ofrecer compensar y nadie sabría por
    // qué. Este comando cambia una cosa y sólo una.
    `insert into app.agreement_versions
       (household_id, agreement_id, version_number, effective_from,
        monthly_salary_cents, overtime_hourly_rate_cents, worked_rest_day_rate_cents,
        worked_rest_day_credit_minutes, contracted_weekly_minutes, annual_vacation_days,
        unused_vacation_day_rate_cents, terms, reason, created_by_membership_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
     returning id`,
    [
      householdId,
      payload.agreementId,
      current.version_number + 1,
      payload.effectiveFrom,
      current.monthly_salary_cents,
      current.overtime_hourly_rate_cents,
      current.worked_rest_day_rate_cents,
      current.worked_rest_day_credit_minutes,
      current.contracted_weekly_minutes,
      payload.annualVacationDays,
      current.unused_vacation_day_rate_cents,
      JSON.stringify(current.terms ?? {}),
      payload.reason,
      membership.id,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("La inserción de la versión del acuerdo no devolvió identificador");
  return { resourceId: row.id };
}

/**
 * `leave_request`: apuntar un periodo de vacaciones, anularlo y decidir qué
 * pasa con los días que quedaron sin disfrutar al cerrarse un año de contrato.
 *
 * Solo la familia administradora, la misma que resuelve gastos y cierra
 * liquidaciones; las políticas `vacation_periods_admin_write` y
 * `vacation_carryovers_admin_write` respaldan la restricción en la base. La
 * empleada lo VE (es suyo) pero no lo escribe: el hogar decidió que no hay
 * flujo de solicitud ni de aprobación.
 */
export const vacationCommandHandler: CommandHandler = async (client, membership, envelope) => {
  if (membership.role !== "family_admin") {
    throw new CommandRejectedError(
      "not_allowed",
      "Solo la familia administradora apunta, anula o decide sobre las vacaciones",
    );
  }
  const parsed = vacationCommandPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  if (payload.action === "void") {
    return voidVacationPeriod(client, membership, envelope.householdId, payload);
  }
  if (payload.action === "record") {
    return recordVacationPeriod(client, membership, envelope.householdId, payload);
  }
  return decideVacationCarryover(client, membership, envelope.householdId, payload);
};

/**
 * `agreement`: por ahora una sola acción, el derecho anual de vacaciones. Se
 * separa del resto del expediente porque cambia lo PACTADO, no un hecho: apila
 * una versión nueva en vez de tocar la vigente.
 */
export const agreementCommandHandler: CommandHandler = async (client, membership, envelope) => {
  if (membership.role !== "family_admin") {
    throw new CommandRejectedError(
      "not_allowed",
      "Solo la familia administradora cambia los términos del acuerdo",
    );
  }
  const parsed = agreementCommandPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  return setVacationEntitlement(client, membership, envelope.householdId, parsed.data);
};
