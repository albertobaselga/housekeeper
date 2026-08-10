import { listOutbox, queueOutbox } from './idb';
import { MAX_BLOB_UPLOAD_ATTEMPTS, type OutboxRecord } from './schema';
import type { BlobUploadMapping } from './sync';

/**
 * Re-enlace diferido foto → comando (Ola D-2). Vive en su propio módulo y se
 * carga BAJO DEMANDA desde `performSyncFlush`, justo cuando una foto acaba de
 * subirse: quien nunca captura fotos sin conexión no paga este código.
 *
 * El comando que esperaba esa foto lleva `pendingBlob` en su registro del
 * outbox y por eso NO ha salido todavía (así jamás queda un gasto en el
 * servidor con su justificante huérfano). Aquí se le escribe el identificador
 * real del objeto ya subido y se le quita la espera: en la misma pasada del
 * flush sale ya completo, una sola vez, con su operationId de siempre.
 */
export async function linkUploadedBlob(
  householdId: string,
  mapping: BlobUploadMapping,
  databaseName?: string
): Promise<void> {
  for (const record of await listOutbox(householdId, databaseName)) {
    const pending = record.pendingBlob;
    if (pending?.id !== mapping.blobId) continue;
    const payload = { ...(record.envelope.payload as Record<string, unknown>) };
    payload[pending.payloadField] = mapping.storageObjectId;
    const linked = { ...record, envelope: { ...record.envelope, payload } };
    delete linked.pendingBlob;
    delete linked.blobAttempts;
    await queueOutbox(linked, databaseName);
  }
}

/**
 * Fotos cuyo comando ya está en el triaje esperando decisión humana: el flush
 * deja de reintentarlas solo, para no repetir cada pasada una subida que ya se
 * sabe que no va a salir bien.
 */
export async function blockedBlobIds(householdId: string, databaseName?: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const record of await listOutbox(householdId, databaseName)) {
    if (record.status !== 'pending' && record.pendingBlob) ids.add(record.pendingBlob.id);
  }
  return ids;
}

/**
 * Contabiliza un intento fallido de subir la foto que un comando espera.
 *
 * Sin esto, un fallo persistente de la subida —el caso real que lo destapó: el
 * almacén de documentos caído, que devuelve 503— dejaba el comando con
 * `pendingBlob` puesto y estado `pending` PARA SIEMPRE: no salía nunca, no
 * aparecía en el triaje (que solo lista lo que ya no fluye solo) y la píldora lo
 * contaba como «pendiente de red», que era mentira.
 *
 * Aquí se le pone fin. Un 413/415/422 es un «no» definitivo del servidor sobre
 * ESE fichero (pesa demasiado, no es del tipo que dice ser, o no pasó la
 * revisión) y bloquea a la primera; cualquier otro fallo —503 sin almacén, 5xx,
 * sin red, respuesta ilegible: `status` 0— es transitorio y bloquea tras
 * MAX_BLOB_UPLOAD_ATTEMPTS pasadas. La foto NO se borra: sigue en el
 * dispositivo para que «Reintentar» tenga algo que subir.
 *
 * Devuelve true si el registro ha quedado bloqueado (ya visible en el triaje).
 */
export async function recordBlobUploadFailure(
  householdId: string,
  blobId: string,
  status: number,
  databaseName?: string
): Promise<boolean> {
  const definitive = status === 413 || status === 415 || status === 422;
  let blocked = false;
  for (const record of await listOutbox(householdId, databaseName)) {
    if (record.pendingBlob?.id !== blobId || record.status !== 'pending') continue;
    const attempts = (record.blobAttempts ?? 0) + 1;
    const giveUp = definitive || attempts >= MAX_BLOB_UPLOAD_ATTEMPTS;
    const next: OutboxRecord = {
      ...record,
      blobAttempts: attempts,
      ...(giveUp
        ? {
            status: 'rejected' as const,
            lastErrorCode: definitive ? 'attachment_rejected' : 'attachment_upload_blocked'
          }
        : {})
    };
    await queueOutbox(next, databaseName);
    blocked ||= giveUp;
  }
  return blocked;
}
