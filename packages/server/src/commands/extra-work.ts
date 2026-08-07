import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import { extraWorkCommandPayloadSchema } from "@casa-clara/contracts/schemas";
import {
  transitionExtraWork,
  type ExtraWorkEvent as DomainExtraWorkEvent,
  type ExtraWorkStatus,
} from "@casa-clara/domain";

import type { ActiveMembership } from "../database.js";
import { CommandRejectedError, type CommandHandler } from "../sync.js";
import { loadAgreementVersions, requireAgreement, versionInForceOn } from "./shared.js";

type RegisterPayload = {
  agreementId: UUID;
  kind: "overtime" | "worked_rest_day";
  workedOn: string;
  durationMinutes: number;
  note?: string | undefined;
};

type ResolvePayload = {
  extraWorkEventId: UUID;
  resolution: "money" | "time_off";
  reason: string;
};

const RESOLVABLE_STATUSES: readonly ExtraWorkStatus[] = [
  "requested",
  "accepted",
  "performed",
  "performed_pending_resolution",
];

async function appendTransition(
  client: PoolClient,
  householdId: UUID,
  eventId: UUID,
  actorMembershipId: UUID,
  fromStatus: ExtraWorkStatus | null,
  toStatus: ExtraWorkStatus,
  reason: string,
): Promise<void> {
  const sequence = await client.query<{ seq: number }>(
    `select coalesce(max(sequence_number), 0) + 1 as seq
       from app.extra_work_transitions
      where household_id = $1 and extra_work_event_id = $2`,
    [householdId, eventId],
  );
  await client.query(
    `insert into app.extra_work_transitions
       (household_id, extra_work_event_id, sequence_number, from_status, to_status,
        actor_membership_id, reason)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [householdId, eventId, sequence.rows[0]?.seq ?? 1, fromStatus, toStatus, actorMembershipId, reason],
  );
}

async function registerExtraWork(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: RegisterPayload,
): Promise<{ resourceId: UUID }> {
  if (membership.role !== "employee_live_in" && membership.role !== "family_admin") {
    throw new CommandRejectedError("not_allowed", "Solo la empleada o la familia registran jornadas extra");
  }
  const agreement = await requireAgreement(client, householdId, payload.agreementId);
  if (membership.role === "employee_live_in" && agreement.employeeMembershipId !== membership.id) {
    throw new CommandRejectedError("agreement_not_found", "El acuerdo no pertenece a la empleada actora");
  }
  const origin = membership.role === "employee_live_in" ? "employee_report" : "family_request";

  const inserted = await client.query<{ id: string }>(
    `insert into app.extra_work_events
       (household_id, agreement_id, employee_membership_id, kind, worked_on,
        duration_minutes, note, origin, status, requested_by_membership_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'requested', $9)
     returning id`,
    [
      householdId,
      payload.agreementId,
      agreement.employeeMembershipId,
      payload.kind,
      payload.workedOn,
      payload.durationMinutes,
      payload.note ?? "",
      origin,
      membership.id,
    ],
  );
  const eventId = inserted.rows[0]?.id;
  if (!eventId) throw new Error("La inserción de la jornada extra no devolvió identificador");

  // El trigger constraint diferido exige que el estado inicial tenga su
  // transición seq 1 (NULL -> requested) dentro de la misma transacción.
  await appendTransition(client, householdId, eventId, membership.id, null, "requested", "Jornada extra registrada");
  return { resourceId: eventId };
}

async function resolveExtraWork(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: ResolvePayload,
): Promise<{ resourceId: UUID }> {
  if (membership.role !== "family_admin") {
    throw new CommandRejectedError("not_allowed", "Solo la familia administradora resuelve jornadas extra");
  }

  const loaded = await client.query<{
    id: string;
    agreement_id: string;
    employee_membership_id: string;
    kind: "overtime" | "worked_rest_day";
    worked_on: string;
    duration_minutes: number;
    status: ExtraWorkStatus;
    requested_by_membership_id: string;
  }>(
    `select id, agreement_id, employee_membership_id, kind, worked_on::text as worked_on,
            duration_minutes, status, requested_by_membership_id
       from app.extra_work_events
      where household_id = $1 and id = $2
      for update`,
    [householdId, payload.extraWorkEventId],
  );
  const event = loaded.rows[0];
  if (!event) {
    throw new CommandRejectedError("extra_work_not_found", "La jornada extra no existe en este hogar");
  }
  if (!RESOLVABLE_STATUSES.includes(event.status)) {
    throw new CommandRejectedError("extra_work_not_resolvable", `Estado ${event.status} no admite resolución`);
  }

  // El trigger constraint de historial es DEFERRABLE INITIALLY DEFERRED y
  // encola una comprobación por cada versión de fila; con varios UPDATE en la
  // misma transacción las versiones intermedias fallarían en el commit. En modo
  // IMMEDIATE cada paso se valida al final de su propia sentencia, por eso cada
  // transición se anexa ANTES de actualizar la fila del evento.
  await client.query("set constraints app.extra_work_requires_transition_history immediate");

  let status = event.status;
  if (status === "requested") {
    await appendTransition(
      client, householdId, event.id, membership.id,
      "requested", "performed_pending_resolution", "Trabajo reconocido al resolver",
    );
    await client.query(
      `update app.extra_work_events
          set status = 'performed_pending_resolution',
              performed_by_membership_id = $3, performed_at = now()
        where household_id = $1 and id = $2`,
      [householdId, event.id, event.employee_membership_id],
    );
    status = "performed_pending_resolution";
  } else if (status === "accepted") {
    await appendTransition(
      client, householdId, event.id, membership.id,
      "accepted", "performed", "Trabajo confirmado al resolver",
    );
    await client.query(
      `update app.extra_work_events
          set status = 'performed', performed_by_membership_id = $3, performed_at = now()
        where household_id = $1 and id = $2`,
      [householdId, event.id, event.employee_membership_id],
    );
    status = "performed";
  }

  // La tarifa se congela desde la versión de acuerdo vigente el día trabajado.
  const versions = await loadAgreementVersions(client, householdId, event.agreement_id);
  const version = versionInForceOn(versions, event.worked_on);

  let unitRateCents: bigint;
  let amountCents: bigint;
  let creditMinutes: number;
  if (payload.resolution === "money") {
    if (event.kind === "overtime") {
      unitRateCents = version.overtimeHourlyRateCents;
      // Céntimos exactos en bigint: tarifa/hora * minutos / 60 con redondeo
      // half-up entero; nunca aritmética en coma flotante.
      amountCents = (unitRateCents * BigInt(event.duration_minutes) + 30n) / 60n;
    } else {
      unitRateCents = version.workedRestDayRateCents;
      amountCents = version.workedRestDayRateCents;
    }
    creditMinutes = 0;
  } else {
    unitRateCents =
      event.kind === "overtime" ? version.overtimeHourlyRateCents : version.workedRestDayRateCents;
    amountCents = 0n;
    creditMinutes = version.workedRestDayCreditMinutes;
  }

  // El motor puro valida los invariantes de la resolución (0 céntimos con
  // crédito positivo para time_off, sin crédito para money).
  const domainEvent: DomainExtraWorkEvent = {
    id: event.id,
    status,
    durationMinutes: event.duration_minutes,
    requestedBy: event.requested_by_membership_id,
    approvedBy: null,
    performedAt: null,
    resolution: null,
    frozenUnitRateCents: null,
    frozenAmountCents: null,
    permanentCreditMinutes: 0,
  };
  const resolved = transitionExtraWork(domainEvent, {
    type: "resolve",
    approvedBy: membership.id,
    resolution: payload.resolution,
    unitRateCents,
    amountCents,
    creditMinutes,
  });

  await appendTransition(client, householdId, event.id, membership.id, status, "resolved", payload.reason);
  await client.query(
    `update app.extra_work_events
        set status = 'resolved',
            resolution = $3,
            resolved_agreement_version_id = $4,
            frozen_unit_rate_cents = $5,
            frozen_amount_cents = $6,
            balance_minutes = $7,
            approved_by_membership_id = coalesce(approved_by_membership_id, $8),
            approved_at = coalesce(approved_at, now()),
            resolved_by_membership_id = $8,
            resolved_at = now(),
            resolution_reason = $9
      where household_id = $1 and id = $2`,
    [
      householdId,
      event.id,
      payload.resolution,
      version.id,
      (resolved.frozenUnitRateCents ?? 0n).toString(),
      (resolved.frozenAmountCents ?? 0n).toString(),
      resolved.permanentCreditMinutes,
      membership.id,
      payload.reason,
    ],
  );

  if (payload.resolution === "time_off") {
    // El crédito de descanso es PERMANENTE: vive como asiento append-only en el
    // libro de compensaciones, nunca como un contador que caduque.
    const existingAccount = await client.query<{ id: string }>(
      `select id
         from app.compensation_accounts
        where household_id = $1 and employee_membership_id = $2 and balance_type = 'worked_rest_day'`,
      [householdId, event.employee_membership_id],
    );
    let accountId = existingAccount.rows[0]?.id;
    if (!accountId) {
      const createdAccount = await client.query<{ id: string }>(
        `insert into app.compensation_accounts
           (household_id, agreement_id, employee_membership_id, balance_type)
         values ($1, $2, $3, 'worked_rest_day')
         returning id`,
        [householdId, event.agreement_id, event.employee_membership_id],
      );
      accountId = createdAccount.rows[0]?.id;
      if (!accountId) throw new Error("La creación de la cuenta de compensación no devolvió identificador");
    }
    // Mismo advisory lock que usa el trigger del libro, tomado antes de leer la
    // secuencia para que el número calculado no compita con otra transacción.
    await client.query("select pg_advisory_xact_lock(hashtextextended($1::text, 1))", [accountId]);
    const sequence = await client.query<{ seq: string }>(
      `select coalesce(max(sequence_number), 0) + 1 as seq
         from app.compensation_ledger_entries
        where household_id = $1 and account_id = $2`,
      [householdId, accountId],
    );
    await client.query(
      `insert into app.compensation_ledger_entries
         (household_id, account_id, sequence_number, kind, delta_minutes, effective_on,
          source_type, source_id, recorded_by_membership_id, note)
       values ($1, $2, $3, 'credit', $4, $5, 'extra_work_event', $6, $7, $8)`,
      [
        householdId,
        accountId,
        sequence.rows[0]?.seq ?? "1",
        resolved.permanentCreditMinutes,
        event.worked_on,
        event.id,
        membership.id,
        payload.reason,
      ],
    );
  }

  return { resourceId: event.id };
}

/**
 * `extra_work`: registro (empleada u origen familiar) y resolución (solo la
 * familia administradora) de jornadas extra. La resolución recorre la máquina
 * de estados del trigger paso a paso y congela la tarifa vigente el día
 * trabajado usando el motor puro de dominio.
 */
export const extraWorkCommandHandler: CommandHandler = async (client, membership, envelope) => {
  const parsed = extraWorkCommandPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  if (payload.action === "register") {
    return registerExtraWork(client, membership, envelope.householdId, payload);
  }
  return resolveExtraWork(client, membership, envelope.householdId, payload);
};
