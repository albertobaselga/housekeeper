import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import { manualAdjustmentCommandPayloadSchema } from "@casa-clara/contracts/schemas";
import {
  DomainRuleError,
  imputationMonth,
  monthFirstDay,
  monthLabel,
  type PeriodMonth,
} from "@casa-clara/domain";

import type { ActiveMembership } from "../database.js";
import { CommandRejectedError, type CommandHandler } from "../sync.js";

interface RecordPayload {
  agreementId: UUID;
  period: string;
  label: string;
  reason: string;
  amountCents: string;
  addsToPay: boolean;
}

interface VoidPayload {
  manualAdjustmentId: UUID;
  reason: string;
}

/** Último día natural del mes, para comparar con las fechas del acuerdo. */
function monthLastDay(period: PeriodMonth): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(lastDay).padStart(2, "0")}`;
}

/**
 * Apunta un concepto a mano y lo imputa al mes que toque.
 *
 * Las tres cosas que decide este comando, con su porqué:
 *
 * · **El mes.** Quien administra elige. Un mes ya empezado vale: apuntar sobre
 *   la cuenta en curso es el caso normal. Un mes ya CERRADO no se reescribe —el
 *   recibo se generó, el total se congeló con su hash y puede estar pagado—, así
 *   que el concepto cae al primer mes posterior que siga abierto y la fila se
 *   queda con la frase que lo explica. La regla vive en el dominio
 *   (`imputationMonth`) y el disparador de 0022 la vuelve a imponer bajo
 *   cerrojo por si dos peticiones llegan a la vez.
 *
 * · **El sitio.** El concepto tiene que caer dentro del acuerdo. Un importe
 *   imputado a un mes en el que nadie trabajaba no es un concepto, es un error
 *   de tecleo que ensuciaría una cuenta.
 *
 * · **El signo y la verdad.** El importe llega con su signo y `addsToPay` dice
 *   si mueve la transferencia. No se valida más: que una gratificación sea
 *   grande o que un descuento sea discutible no es asunto de la aplicación,
 *   pero que el total del mes mienta sí lo es.
 */
async function recordManualAdjustment(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: RecordPayload,
): Promise<{ resourceId: UUID }> {
  const requested = payload.period as PeriodMonth;

  // Una sola lectura del acuerdo: de ella salen a quién pertenece la cuenta y
  // entre qué fechas existe.
  const loaded = await client.query<{
    employee_membership_id: string;
    starts_on: string;
    ends_on: string | null;
  }>(
    `select employee_membership_id, starts_on::text as starts_on, ends_on::text as ends_on
       from app.employment_agreements
      where household_id = $1 and id = $2`,
    [householdId, payload.agreementId],
  );
  const agreement = loaded.rows[0];
  if (!agreement) {
    throw new CommandRejectedError("agreement_not_found", "El acuerdo no existe o no es visible");
  }
  if (monthLastDay(requested) < agreement.starts_on) {
    throw new CommandRejectedError(
      "adjustment_before_agreement",
      `El acuerdo empezó el ${agreement.starts_on}: no hay cuenta de ${monthLabel(requested)}`,
    );
  }
  if (agreement.ends_on !== null && monthFirstDay(requested) > agreement.ends_on) {
    throw new CommandRejectedError(
      "adjustment_after_agreement",
      `El acuerdo terminó el ${agreement.ends_on}: no hay cuenta de ${monthLabel(requested)}`,
    );
  }

  // Meses ya cerrados de este acuerdo, desde el pedido en adelante. Se leen bajo
  // el cerrojo que también toma el cierre (0022), de modo que un cierre
  // simultáneo o espera aquí o llega después y encuentra el concepto ya puesto.
  await client.query("select app.lock_settlement_month($1::uuid, $2::date)", [
    payload.agreementId,
    monthFirstDay(requested),
  ]);
  const closed = await client.query<{ period: string }>(
    `select to_char(period_start, 'YYYY-MM') as period
       from app.settlements
      where household_id = $1 and agreement_id = $2 and status = 'closed'
        and period_end >= $3::date
      order by period_start`,
    [householdId, payload.agreementId, monthFirstDay(requested)],
  );

  let imputation;
  try {
    imputation = imputationMonth(
      requested,
      closed.rows.map((row) => row.period as PeriodMonth),
    );
  } catch (cause) {
    if (cause instanceof DomainRuleError) {
      throw new CommandRejectedError("no_open_month", cause.message);
    }
    throw cause;
  }

  const inserted = await client.query<{ id: string }>(
    `insert into app.manual_adjustments
       (household_id, agreement_id, employee_membership_id, period_month,
        requested_period_month, label, reason, amount_cents, adds_to_pay,
        deferral_note, recorded_by_membership_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id`,
    [
      householdId,
      payload.agreementId,
      agreement.employee_membership_id,
      monthFirstDay(imputation.period),
      monthFirstDay(imputation.requested),
      payload.label,
      payload.reason,
      payload.amountCents,
      payload.addsToPay,
      imputation.note,
      membership.id,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("La inserción del concepto no devolvió identificador");
  return { resourceId: row.id };
}

/**
 * Anula un concepto mal apuntado. No borra: la fila se queda con quién la
 * anuló, cuándo y por qué, y deja de contar en la cuenta del mes. Es el mismo
 * patrón de `app.payments` y de las vacaciones.
 *
 * Un concepto inexistente y uno ya anulado colapsan en el mismo rechazo: para
 * quien pregunta, ambos significan «aquí no queda nada que corregir».
 *
 * Lo que NO se puede anular es un concepto cuya cuenta ya se cerró: borrarlo de
 * un total congelado y firmado sería reescribir el pasado. El disparador de
 * 0022 lo rechaza aunque alguien fabrique la petición a mano; aquí se comprueba
 * antes para poder decir en castellano qué hacer en su lugar.
 */
async function voidManualAdjustment(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: VoidPayload,
): Promise<{ resourceId: UUID }> {
  const loaded = await client.query<{
    id: string;
    agreement_id: string;
    status: string;
    period: string;
  }>(
    `select id, agreement_id, status, to_char(period_month, 'YYYY-MM') as period
       from app.manual_adjustments
      where household_id = $1 and id = $2
      for update`,
    [householdId, payload.manualAdjustmentId],
  );
  const adjustment = loaded.rows[0];
  if (!adjustment || adjustment.status !== "recorded") {
    throw new CommandRejectedError(
      "adjustment_not_recorded",
      adjustment ? "Ese concepto ya estaba anulado" : "El concepto no existe en este hogar",
    );
  }

  await client.query("select app.lock_settlement_month($1::uuid, $2::date)", [
    adjustment.agreement_id,
    monthFirstDay(adjustment.period as PeriodMonth),
  ]);
  const closed = await client.query(
    `select 1
       from app.settlements
      where household_id = $1 and agreement_id = $2 and status = 'closed'
        and period_start <= ($3::date + interval '1 month - 1 day')::date
        and period_end >= $3::date
      limit 1`,
    [householdId, adjustment.agreement_id, monthFirstDay(adjustment.period as PeriodMonth)],
  );
  if ((closed.rowCount ?? 0) > 0) {
    throw new CommandRejectedError(
      "settlement_already_closed",
      `La cuenta de ${monthLabel(adjustment.period as PeriodMonth)} ya está cerrada: apunta el concepto contrario en un mes abierto`,
    );
  }

  await client.query(
    `update app.manual_adjustments
        set status = 'voided',
            voided_by_membership_id = $3,
            voided_at = now(),
            void_reason = $4
      where household_id = $1 and id = $2`,
    [householdId, adjustment.id, membership.id, payload.reason],
  );
  return { resourceId: adjustment.id };
}

/**
 * `manual_adjustment`: apuntar un concepto a mano y anularlo. Solo la familia
 * administradora —es quien decide sobre el dinero de la cuenta—, y la política
 * `manual_adjustments_admin_write` lo respalda en la base de datos. La empleada
 * los VE (aparecen en su cuenta del mes con su etiqueta y su motivo) pero no
 * los escribe.
 */
export const manualAdjustmentCommandHandler: CommandHandler = async (
  client,
  membership,
  envelope,
) => {
  if (membership.role !== "family_admin") {
    throw new CommandRejectedError(
      "not_allowed",
      "Solo la familia administradora apunta o anula conceptos",
    );
  }
  const parsed = manualAdjustmentCommandPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  if (payload.action === "void") {
    return voidManualAdjustment(client, membership, envelope.householdId, payload);
  }
  return recordManualAdjustment(client, membership, envelope.householdId, payload);
};
