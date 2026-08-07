import { weeklyReportSubmitPayloadSchema } from "@casa-clara/contracts/schemas";

import { CommandRejectedError, type CommandHandler } from "../sync.js";
import { addDays, requireAgreement } from "./shared.js";

/**
 * `time_entry` / submit_week: la empleada interna envía su semana (que empieza
 * en lunes) con sus entradas diarias. El parte nace directamente en estado
 * `submitted` con la membresía actora como remitente; una semana ya enviada se
 * rechaza como `week_already_reported` (la restricción única de la tabla cubre
 * la carrera).
 */
export const submitWeeklyReportHandler: CommandHandler = async (client, membership, envelope) => {
  if (membership.role !== "employee_live_in") {
    throw new CommandRejectedError("not_allowed", "Solo la empleada envía su propia semana");
  }
  const parsed = weeklyReportSubmitPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;

  if (new Date(`${payload.weekStartsOn}T00:00:00Z`).getUTCDay() !== 1) {
    throw new CommandRejectedError("invalid_payload", "La semana debe empezar en lunes");
  }
  const weekEndsOn = addDays(payload.weekStartsOn, 6);
  for (const entry of payload.entries) {
    if (entry.workedOn < payload.weekStartsOn || entry.workedOn > weekEndsOn) {
      throw new CommandRejectedError("invalid_payload", "Cada entrada debe caer dentro de la semana enviada");
    }
  }

  const agreement = await requireAgreement(client, envelope.householdId, payload.agreementId);
  if (agreement.employeeMembershipId !== membership.id) {
    throw new CommandRejectedError("agreement_not_found", "El acuerdo no pertenece a la empleada actora");
  }

  const existing = await client.query(
    `select 1
       from app.weekly_time_reports
      where household_id = $1 and employee_membership_id = $2 and week_starts_on = $3`,
    [envelope.householdId, membership.id, payload.weekStartsOn],
  );
  if ((existing.rowCount ?? 0) > 0) {
    throw new CommandRejectedError("week_already_reported", "La semana ya fue enviada");
  }

  const inserted = await client.query<{ id: string }>(
    `insert into app.weekly_time_reports
       (household_id, agreement_id, employee_membership_id, week_starts_on,
        status, submitted_at, submitted_by_membership_id)
     values ($1, $2, $3, $4, 'submitted', now(), $3)
     returning id`,
    [envelope.householdId, payload.agreementId, membership.id, payload.weekStartsOn],
  );
  const reportId = inserted.rows[0]?.id;
  if (!reportId) throw new Error("La inserción del parte semanal no devolvió identificador");

  for (const entry of payload.entries) {
    await client.query(
      `insert into app.time_entries
         (household_id, report_id, employee_membership_id, worked_on,
          started_at, ended_at, regular_minutes, note)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        envelope.householdId,
        reportId,
        membership.id,
        entry.workedOn,
        entry.startedAt ?? null,
        entry.endedAt ?? null,
        entry.regularMinutes,
        entry.note ?? "",
      ],
    );
  }

  return { resourceId: reportId };
};
