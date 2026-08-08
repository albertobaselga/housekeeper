import { error } from '@sveltejs/kit';

import { createAttachmentDependencies } from '$lib/server/attachment-deps.server';
import { loadExpenseReceipt } from '$lib/server/receipts.server';
import type { RequestHandler } from './$types';

/**
 * Ver el justificante de un gasto ya reembolsado desde la cuenta del mes
 * (Ola D-3). Solo lectura: no escribe nada y la cuenta cerrada sigue
 * intocable. Quién puede verlo lo decide RLS en `loadExpenseReceipt`; sin
 * fila, 404, sin distinguir «no existe» de «no te toca».
 */
export const GET: RequestHandler = async ({ locals, params, setHeaders }) => {
  if (!locals.user) error(401, 'Inicia sesión para ver el justificante');
  if (!locals.user.householdIds.includes(params.householdId)) error(404, 'Hogar no encontrado');

  const receipt = await loadExpenseReceipt({ id: locals.user.id }, params.householdId, params.expenseId);
  if (!receipt) error(404, 'Ese gasto no tiene justificante guardado');

  const deps = createAttachmentDependencies();
  if (!deps) error(503, 'Ver el justificante requiere el almacén de documentos del hogar');

  // En flujo cuando el almacén lo permite: una función serverless no puede
  // devolver más de 4,5 MB materializados y un justificante llega a 10 MiB.
  // El tamaño lo da la fila de app.storage_objects, así que la cabecera
  // content-length sigue siendo exacta sin necesidad de leerlo entero.
  let stream: ReadableStream<Uint8Array> | null = null;
  let bytes: Uint8Array | null = null;
  try {
    if (deps.getObjectStream) stream = await deps.getObjectStream(receipt.objectKey);
    else bytes = await deps.getObject(receipt.objectKey);
  } catch {
    error(503, 'No se pudo recuperar el justificante del almacén del hogar');
  }

  setHeaders({ 'cache-control': 'private, no-store' });
  const headers = {
    'content-type': receipt.mediaType,
    // Se abre en el navegador (mirar el ticket), no se fuerza la descarga.
    'content-disposition': `inline; filename="justificante-${receipt.documentId}"`,
    'content-length': bytes ? String(bytes.length) : receipt.byteSize
  };
  return stream
    ? new Response(stream, { headers })
    : new Response(new Uint8Array(bytes ?? []), { headers });
};
