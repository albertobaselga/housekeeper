import { paymentRecordPayloadSchema } from "@housekeeper/contracts/schemas";

import { CommandRejectedError, type CommandHandler } from "../sync.js";

/**
 * `payment` / record: la familia administradora registra un pago (parcial o
 * total) contra una liquidación cerrada. La fila de la liquidación se bloquea
 * para serializar pagos concurrentes y el importe se valida en céntimos bigint
 * contra la vista `settlement_payment_totals`: nunca puede excederse el total
 * congelado.
 */
export const recordPaymentHandler: CommandHandler = async (client, membership, envelope) => {
  if (membership.role !== "family_admin") {
    throw new CommandRejectedError("not_allowed", "Solo la familia administradora registra pagos");
  }
  const parsed = paymentRecordPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;

  const loaded = await client.query<{ id: string; employee_membership_id: string; status: string }>(
    `select id, employee_membership_id, status
       from app.settlements
      where household_id = $1 and id = $2
      for update`,
    [envelope.householdId, payload.settlementId],
  );
  const settlement = loaded.rows[0];
  if (!settlement) {
    throw new CommandRejectedError("settlement_not_found", "La liquidación no existe en este hogar");
  }
  if (settlement.status !== "closed") {
    throw new CommandRejectedError("settlement_not_closed", "Solo se paga una liquidación cerrada");
  }

  const totals = await client.query<{ pending_cents: string }>(
    `select pending_cents::text as pending_cents
       from app.settlement_payment_totals
      where household_id = $1 and settlement_id = $2`,
    [envelope.householdId, settlement.id],
  );
  const pending = BigInt(totals.rows[0]?.pending_cents ?? "0");
  if (BigInt(payload.amountCents) > pending) {
    throw new CommandRejectedError(
      "payment_exceeds_settlement",
      `El pago supera los ${pending} céntimos pendientes`,
    );
  }

  const inserted = await client.query<{ id: string }>(
    `insert into app.payments
       (household_id, settlement_id, employee_membership_id, amount_cents,
        method, value_on, reference, status, recorded_by_membership_id)
     values ($1, $2, $3, $4, $5, $6, $7, 'recorded', $8)
     returning id`,
    [
      envelope.householdId,
      settlement.id,
      settlement.employee_membership_id,
      payload.amountCents,
      payload.method,
      payload.valueOn,
      payload.reference ?? "",
      membership.id,
    ],
  );
  const paymentId = inserted.rows[0]?.id;
  if (!paymentId) throw new Error("La inserción del pago no devolvió identificador");
  return { resourceId: paymentId };
};
