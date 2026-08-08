import { listOutbox, queueOutbox } from './idb';
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
    await queueOutbox(linked, databaseName);
  }
}
