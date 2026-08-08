import type { Pool } from 'pg';

import { AuthorizationError, createLogger, errorCode, withAuthorizedTransaction } from '@casa-clara/server';

import { getDatabasePool } from './db.server';

const log = createLogger('web:receipts');

export interface ExpenseReceipt {
  /** Documento de tipo `expense_receipt` enlazado al gasto. */
  documentId: string;
  objectKey: string;
  bucket: string;
  mediaType: string;
  byteSize: string;
  /** Título del documento; sirve de nombre de fichero al descargarlo. */
  title: string;
}

/**
 * Justificante de un gasto ya reembolsado, para poder MIRARLO desde la cuenta
 * del mes cerrada. Solo lectura: aquí no se escribe nada y la cuenta cerrada
 * sigue intocable. Es RLS quien decide el acceso —las políticas de
 * `app.expenses`, `app.documents` (visibilidad `employment`) y
 * `app.storage_objects` ya limitan las filas a quien puede ver la cuenta—, así
 * que a un apoyo o un visor esta consulta le devuelve cero filas.
 *
 * Devuelve null sin pool (demo), sin membresía, o cuando el gasto no existe o
 * se aprobó sin foto.
 */
export async function loadExpenseReceipt(
  user: { id: string },
  householdId: string,
  expenseId: string,
  pool: Pool | null = getDatabasePool()
): Promise<ExpenseReceipt | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client) => {
      const result = await client.query<ExpenseReceipt>(
        `select document.id as "documentId",
                object.object_key as "objectKey",
                object.bucket,
                object.media_type as "mediaType",
                object.byte_size::text as "byteSize",
                document.title
           from app.expenses as expense
           join app.documents as document
             on document.household_id = expense.household_id
            and document.id = expense.receipt_document_id
           join app.storage_objects as object
             on object.household_id = document.household_id
            and object.id = document.storage_object_id
          where expense.household_id = $1 and expense.id = $2
            and object.deleted_at is null`,
        [householdId, expenseId]
      );
      return result.rows[0] ?? null;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('receipt unavailable', { code: errorCode(cause) });
    }
    return null;
  }
}
