import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import {
  expenseResolvePayloadSchema,
  expenseSubmitPayloadSchema,
} from "@casa-clara/contracts/schemas";

import type { ActiveMembership } from "../database.js";
import { CommandRejectedError, type CommandHandler } from "../sync.js";

type SubmitPayload = {
  agreementId: UUID;
  incurredOn: string;
  description: string;
  amountCents: string;
  receiptStorageObjectId?: UUID | undefined;
};

type ResolvePayload = {
  expenseId: UUID;
  resolution: "approved" | "rejected";
  reason: string;
};

/**
 * Enlaza el justificante subido con el gasto: verifica bajo RLS que el
 * storage_object existe en el hogar Y fue creado por la propia membresía (la
 * política `storage_objects_read` ya limita la visibilidad, pero un admin ve
 * objetos ajenos, así que el filtro por autora es explícito) y materializa la
 * fila `app.documents` con visibilidad `employment` que el resto del expediente
 * puede leer. Devuelve el id del documento para fijar `receipt_document_id`.
 */
async function createReceiptDocument(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  storageObjectId: UUID,
  title: string,
): Promise<UUID> {
  const object = await client.query<{ id: string }>(
    `select id
       from app.storage_objects
      where household_id = $1 and id = $2
        and created_by_membership_id = $3
        and deleted_at is null`,
    [householdId, storageObjectId, membership.id],
  );
  if (!object.rows[0]) {
    throw new CommandRejectedError(
      "receipt_not_found",
      "El justificante no existe en este hogar o no lo subiste tú",
    );
  }

  const document = await client.query<{ id: string }>(
    `insert into app.documents
       (household_id, storage_object_id, owner_membership_id, visibility,
        document_type, title, created_by_membership_id)
     values ($1, $2, $3, 'employment', 'expense_receipt', $4, $3)
     returning id`,
    [householdId, storageObjectId, membership.id, title],
  );
  const row = document.rows[0];
  if (!row) throw new Error("La inserción del documento no devolvió identificador");
  return row.id;
}

async function submitExpense(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: SubmitPayload,
): Promise<{ resourceId: UUID }> {
  // El documento se crea ANTES que el gasto: si el storage_object no es válido
  // el comando se rechaza entero y no queda un gasto huérfano de justificante.
  const receiptDocumentId = payload.receiptStorageObjectId
    ? await createReceiptDocument(
        client,
        membership,
        householdId,
        payload.receiptStorageObjectId,
        payload.description,
      )
    : null;

  const inserted = await client.query<{ id: string }>(
    `insert into app.expenses
       (household_id, agreement_id, employee_membership_id, incurred_on,
        description, amount_cents, status, submitted_by_membership_id, receipt_document_id)
     values ($1, $2, $3, $4, $5, $6, 'pending', $3, $7)
     returning id`,
    [
      householdId,
      payload.agreementId,
      membership.id,
      payload.incurredOn,
      payload.description,
      payload.amountCents,
      receiptDocumentId,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("La inserción del gasto no devolvió identificador");
  return { resourceId: row.id };
}

async function resolveExpense(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: ResolvePayload,
): Promise<{ resourceId: UUID }> {
  const loaded = await client.query<{ id: string; status: string }>(
    `select id, status
       from app.expenses
      where household_id = $1 and id = $2
      for update`,
    [householdId, payload.expenseId],
  );
  const expense = loaded.rows[0];
  // Gasto inexistente y gasto ya resuelto colapsan en el mismo rechazo: para el
  // cliente ambos significan "no hay nada pendiente que resolver aquí".
  if (!expense || expense.status !== "pending") {
    throw new CommandRejectedError(
      "expense_not_pending",
      expense ? `Estado ${expense.status} no admite resolución` : "El gasto no existe en este hogar",
    );
  }

  // El CHECK de la tabla y el trigger de transición exigen que approved/rejected
  // lleguen con resolved_by, resolved_at y motivo no vacío en el mismo UPDATE.
  await client.query(
    `update app.expenses
        set status = $3,
            resolved_by_membership_id = $4,
            resolved_at = now(),
            resolution_reason = $5
      where household_id = $1 and id = $2`,
    [householdId, expense.id, payload.resolution, membership.id, payload.reason],
  );
  return { resourceId: expense.id };
}

/**
 * `expense`: alta de gasto propio de la empleada (base de AC-11) y resolución
 * administrativa. Un payload sin `action` conserva el flujo submit original;
 * `action: 'resolve'` aprueba o rechaza un gasto `pending` y solo está al
 * alcance de la familia administradora (la política RLS `expenses_admin_all`
 * respalda esa restricción en la base).
 */
export const submitExpenseHandler: CommandHandler = async (client, membership, envelope) => {
  const hasAction =
    typeof envelope.payload === "object" && envelope.payload !== null && "action" in envelope.payload;

  if (hasAction) {
    if (membership.role !== "family_admin") {
      throw new CommandRejectedError("not_allowed", "Solo la familia administradora resuelve gastos");
    }
    const parsed = expenseResolvePayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
    }
    return resolveExpense(client, membership, envelope.householdId, parsed.data);
  }

  if (membership.role !== "employee_live_in") {
    throw new CommandRejectedError("not_allowed", "Solo la empleada registra sus propios gastos");
  }
  const parsed = expenseSubmitPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  return submitExpense(client, membership, envelope.householdId, parsed.data);
};
