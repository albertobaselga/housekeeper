import { error } from '@sveltejs/kit';

import { belongsToHousehold } from '$lib/auth/membership';
import { createAttachmentDependencies } from '$lib/server/attachment-deps.server';
import { ALLOWED_ATTACHMENT_TYPES } from '$lib/server/attachments.server';
import { loadExpenseReceipt } from '$lib/server/receipts.server';
import type { RequestHandler } from './$types';

/**
 * Ver el justificante de un gasto: el pendiente de aprobación y el ya
 * reembolsado desde la cuenta del mes (Ola D-3). Solo lectura: no escribe nada
 * y la cuenta cerrada sigue intocable. Quién puede verlo lo decide RLS en
 * `loadExpenseReceipt`; sin fila, 404, sin distinguir «no existe» de «no te
 * toca».
 *
 * Leer NO depende del antivirus: solo hace falta el almacén de documentos.
 */
export const GET: RequestHandler = async ({ locals, params, setHeaders }) => {
  if (!locals.user) error(401, 'Inicia sesión para ver el justificante');
  if (!belongsToHousehold(locals.user, params.householdId)) error(404, 'Hogar no encontrado');

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
  // El tipo sale de la lista blanca, no de la fila: aunque alguien lograse
  // escribir otra cosa en `media_type`, el navegador nunca recibirá un
  // `content-type` que no sea una de las cuatro formas admitidas.
  const mediaType = Object.hasOwn(ALLOWED_ATTACHMENT_TYPES, receipt.mediaType)
    ? receipt.mediaType
    : 'application/octet-stream';
  const extension = ALLOWED_ATTACHMENT_TYPES[mediaType] ?? '';
  const headers = {
    'content-type': mediaType,
    // Se abre en el navegador (mirar el ticket), no se fuerza la descarga.
    'content-disposition': `inline; filename="justificante-${receipt.documentId}${extension}"`,
    'content-length': bytes ? String(bytes.length) : receipt.byteSize,
    // Sin antivirus delante, estas dos cabeceras son la red de seguridad de
    // servir un fichero de terceros desde nuestro propio origen: `nosniff`
    // impide que el navegador reinterprete los bytes como otra cosa, y el
    // sandbox deja el documento sin origen —un PDF con JavaScript dentro no
    // puede tocar la sesión de la casa—. Ver docs/security/adjuntos-sin-antivirus.md.
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'"
  };
  return stream
    ? new Response(stream, { headers })
    : new Response(new Uint8Array(bytes ?? []), { headers });
};
