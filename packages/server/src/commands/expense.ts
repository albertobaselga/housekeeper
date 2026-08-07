import { expenseSubmitPayloadSchema } from "@casa-clara/contracts/schemas";

import { CommandRejectedError, type CommandHandler } from "../sync.js";

/**
 * Alta de gasto propio de la empleada (base de AC-11). La política RLS exige que
 * la fila pertenezca a su membresía y quede en estado `pending`; cualquier otro
 * rol debe pasar por un flujo administrativo aún no implementado.
 */
export const submitExpenseHandler: CommandHandler = async (client, membership, envelope) => {
  if (membership.role !== "employee_live_in") {
    throw new CommandRejectedError("not_allowed", "Solo la empleada registra sus propios gastos");
  }
  const parsed = expenseSubmitPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;

  const inserted = await client.query<{ id: string }>(
    `insert into app.expenses
       (household_id, agreement_id, employee_membership_id, incurred_on,
        description, amount_cents, status, submitted_by_membership_id)
     values ($1, $2, $3, $4, $5, $6, 'pending', $3)
     returning id`,
    [
      envelope.householdId,
      payload.agreementId,
      membership.id,
      payload.incurredOn,
      payload.description,
      payload.amountCents,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("La inserción del gasto no devolvió identificador");
  return { resourceId: row.id };
};
