import type { Pool } from "pg";

import { formatEuroCents } from "./documents.js";
import { PermanentJobError, type JobHandler } from "./queue.js";

export const SETTLEMENT_DUE_JOB = "notification.settlement_due";
export const AUTOCONFIRM_JOB = "time_report.autoconfirm";

/** Cadencia de escalada: mientras siga pendiente, se reavisa cada tres días. */
export const REMINDER_ESCALATION_DAYS = 3;

const DAY_MS = 86_400_000;

/** Fila de `app_private.settlement_reminder_state` normalizada a camelCase. */
export interface SettlementReminderState {
  dueOn: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  pendingCents: string;
  receiptConfirmed: boolean;
  employeeEmail: string | null;
  adminEmails: ReadonlyArray<string | null>;
}

export interface ReminderEmail {
  to: string;
  subject: string;
  text: string;
}

export interface ReminderEnqueueInput {
  householdId: string;
  type: string;
  payload: unknown;
  runAt: Date;
}

export interface SettlementDueDeps {
  readState: (householdId: string, settlementId: string) => Promise<SettlementReminderState | null>;
  sendEmail: (input: ReminderEmail) => Promise<void>;
  enqueue: (input: ReminderEnqueueInput) => Promise<void>;
  now?: () => Date;
}

export interface AutoconfirmDeps {
  autoconfirm: (householdId: string, reportId: string) => Promise<boolean>;
}

function requireIdentifier(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PermanentJobError(`El payload del recordatorio requiere ${field}`);
  }
  return value;
}

/** `2025-05-05` → `05/05/2025`, sin depender de la zona horaria del proceso. */
function formatDateEs(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return isoDate;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function reminderEmailBody(state: SettlementReminderState): { subject: string; text: string } {
  return {
    subject: `Liquidación pendiente de pago (vence el ${formatDateEs(state.dueOn)})`,
    text: [
      "Hola:",
      "",
      `La liquidación del periodo ${formatDateEs(state.periodStart)} a ${formatDateEs(state.periodEnd)} sigue pendiente de pago.`,
      `Importe pendiente: ${formatEuroCents(state.pendingCents)}.`,
      `Fecha límite de pago: ${formatDateEs(state.dueOn)}.`,
      "",
      "Este aviso automático se repetirá cada 3 días hasta que el pago se complete",
      "y la empleada confirme el cobro.",
      "",
      "— Gestión del personal doméstico",
    ].join("\n"),
  };
}

/**
 * Aviso de vencimiento de liquidación. El worker no lee tablas de dominio: el
 * estado llega por la función de alcance mínimo
 * `app_private.settlement_reminder_state`. Solo avisa si la liquidación sigue
 * cerrada, con pendiente y sin confirmación de cobro; en ese caso además se
 * re-encola a sí mismo a +3 días (escalada). Pagada, confirmada o anulada:
 * completa sin efectos.
 */
export function createSettlementDueHandler(deps: SettlementDueDeps): JobHandler {
  const now = deps.now ?? (() => new Date());
  return async (job) => {
    const settlementId = requireIdentifier(job.payload, "settlementId");
    const state = await deps.readState(job.householdId, settlementId);
    if (!state) {
      throw new PermanentJobError("La liquidación del aviso no existe en este hogar");
    }
    if (state.status !== "closed" || BigInt(state.pendingCents) <= 0n || state.receiptConfirmed) {
      return;
    }

    const recipients = [
      ...new Set(
        [...state.adminEmails, state.employeeEmail].filter(
          (email): email is string => typeof email === "string" && email.trim().length > 0,
        ),
      ),
    ];
    const { subject, text } = reminderEmailBody(state);
    for (const to of recipients) {
      await deps.sendEmail({ to, subject, text });
    }

    await deps.enqueue({
      householdId: job.householdId,
      type: SETTLEMENT_DUE_JOB,
      payload: { settlementId },
      runAt: new Date(now().getTime() + REMINDER_ESCALATION_DAYS * DAY_MS),
    });
  };
}

/**
 * Auto-confirmación del parte semanal. `app_private.autoconfirm_weekly_report`
 * es idempotente y solo confirma partes `submitted` con tres días de silencio;
 * `false` (ya confirmado, disputado o aún sin cumplir el plazo) también es un
 * resultado correcto y el job completa sin más.
 */
export function createAutoconfirmHandler(deps: AutoconfirmDeps): JobHandler {
  return async (job) => {
    const reportId = requireIdentifier(job.payload, "reportId");
    await deps.autoconfirm(job.householdId, reportId);
  };
}

/**
 * Dependencias reales sobre el pool del worker: las dos funciones
 * `app_private.*` con EXECUTE para `casa_clara_worker` y el INSERT directo en
 * `app_private.job_queue` (el worker no puede usar `app.enqueue_job`, que exige
 * contexto de aplicación).
 */
export function createReminderQueries(pool: Pool): {
  readSettlementReminderState: SettlementDueDeps["readState"];
  enqueueJob: SettlementDueDeps["enqueue"];
  autoconfirmWeeklyReport: AutoconfirmDeps["autoconfirm"];
} {
  return {
    readSettlementReminderState: async (householdId, settlementId) => {
      const result = await pool.query<{
        due_on: string;
        period_start: string;
        period_end: string;
        status: string;
        pending_cents: string;
        receipt_confirmed: boolean;
        employee_email: string | null;
        admin_emails: (string | null)[];
      }>(
        `select due_on::text as due_on, period_start::text as period_start,
                period_end::text as period_end, status,
                pending_cents::text as pending_cents, receipt_confirmed,
                employee_email, admin_emails
           from app_private.settlement_reminder_state($1, $2)`,
        [householdId, settlementId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        dueOn: row.due_on,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        status: row.status,
        pendingCents: row.pending_cents,
        receiptConfirmed: row.receipt_confirmed,
        employeeEmail: row.employee_email,
        adminEmails: row.admin_emails,
      };
    },
    enqueueJob: async ({ householdId, type, payload, runAt }) => {
      await pool.query(
        `insert into app_private.job_queue (household_id, job_type, payload, run_at)
         values ($1, $2, $3::jsonb, $4)`,
        [householdId, type, JSON.stringify(payload), runAt],
      );
    },
    autoconfirmWeeklyReport: async (householdId, reportId) => {
      const result = await pool.query<{ confirmed: boolean }>(
        "select app_private.autoconfirm_weekly_report($1, $2) as confirmed",
        [householdId, reportId],
      );
      return result.rows[0]?.confirmed ?? false;
    },
  };
}
