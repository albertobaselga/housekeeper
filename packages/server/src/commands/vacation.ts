import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import {
  agreementCommandPayloadSchema,
  vacationCommandPayloadSchema,
} from "@casa-clara/contracts/schemas";

import type { ActiveMembership } from "../database.js";
import { CommandRejectedError, type CommandHandler } from "../sync.js";
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
    terms: unknown;
  }>(
    `select version_number, effective_from::text as effective_from,
            monthly_salary_cents::text as monthly_salary_cents,
            overtime_hourly_rate_cents::text as overtime_hourly_rate_cents,
            worked_rest_day_rate_cents::text as worked_rest_day_rate_cents,
            worked_rest_day_credit_minutes, contracted_weekly_minutes,
            annual_vacation_days, terms
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
    `insert into app.agreement_versions
       (household_id, agreement_id, version_number, effective_from,
        monthly_salary_cents, overtime_hourly_rate_cents, worked_rest_day_rate_cents,
        worked_rest_day_credit_minutes, contracted_weekly_minutes, annual_vacation_days,
        terms, reason, created_by_membership_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
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
 * `leave_request`: apuntar un periodo de vacaciones y anularlo. Solo la familia
 * administradora, la misma que resuelve gastos y cierra liquidaciones; la
 * política `vacation_periods_admin_write` respalda la restricción en la base.
 * La empleada los VE (son suyos) pero no los escribe: el hogar decidió que no
 * hay flujo de solicitud ni de aprobación.
 */
export const vacationCommandHandler: CommandHandler = async (client, membership, envelope) => {
  if (membership.role !== "family_admin") {
    throw new CommandRejectedError(
      "not_allowed",
      "Solo la familia administradora apunta o anula vacaciones",
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
  return recordVacationPeriod(client, membership, envelope.householdId, payload);
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
