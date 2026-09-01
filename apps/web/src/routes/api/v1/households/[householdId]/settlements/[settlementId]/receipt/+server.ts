import { error } from '@sveltejs/kit';

import { belongsToHousehold } from '$lib/auth/membership';
import { createAttachmentDependencies } from '$lib/server/attachment-deps.server';
import { loadSettlementReceipt } from '$lib/server/employment.server';
import type { RequestHandler } from './$types';

/**
 * Descargar el recibo PDF de una liquidación (Frente E). Calcado de
 * `receipts/[expenseId]/+server.ts`: solo lectura, `nosniff` + CSP `sandbox`,
 * y es RLS —no este código— quien decide el acceso
 * (`settlement_receipts_read`, calcada de `settlements_read`): family_admin
 * del hogar y la propia empleada del contrato. Sin fila (recibo aún no
 * registrado, o quien pregunta no debe verlo) responde 404 sin distinguir un
 * caso del otro.
 */
export const GET: RequestHandler = async ({ locals, params, setHeaders }) => {
  if (!locals.user) error(401, 'Inicia sesión para ver el recibo');
  if (!belongsToHousehold(locals.user, params.householdId)) error(404, 'Hogar no encontrado');

  const receipt = await loadSettlementReceipt(
    { id: locals.user.id },
    params.householdId,
    params.settlementId
  );
  if (!receipt) error(404, 'Esa liquidación no tiene recibo registrado');

  const deps = createAttachmentDependencies();
  if (!deps) error(503, 'Ver el recibo requiere el almacén de documentos del hogar');

  // La fila dice en qué bucket se subió el recibo; esta instalación puede
  // estar configurada contra OTRO (migración de almacén, entorno mal
  // apuntado). Leer de un bucket que no es el registrado devolvería, en el
  // mejor caso, un objeto que no existe, y en el peor, el de otro inquilino
  // del mismo almacén compartido. Se comprueba ANTES de leer nada.
  if (receipt.bucket !== deps.bucket) {
    error(
      503,
      `El recibo está registrado en el almacén ${receipt.bucket} pero esta instalación lee de ${deps.bucket}.`
    );
  }

  // En flujo cuando el almacén lo permite: una función serverless no puede
  // devolver más de 4,5 MB materializados, y el recibo es un PDF de varias
  // páginas en casas con muchos conceptos. El tamaño lo da la fila de
  // app.settlement_receipts, así que la cabecera content-length sigue siendo
  // exacta sin necesidad de leerlo entero.
  let stream: ReadableStream<Uint8Array> | null = null;
  let bytes: Uint8Array | null = null;
  try {
    if (deps.getObjectStream) stream = await deps.getObjectStream(receipt.objectKey);
    else bytes = await deps.getObject(receipt.objectKey);
  } catch {
    error(503, 'No se pudo recuperar el recibo del almacén del hogar');
  }

  setHeaders({ 'cache-control': 'private, no-store' });
  const headers = {
    'content-type': receipt.mediaType,
    // Se abre en el navegador (mirar o guardar desde ahí), no se fuerza la
    // descarga.
    'content-disposition': `inline; filename="recibo-${receipt.period}.pdf"`,
    'content-length': bytes ? String(bytes.length) : receipt.byteSize,
    // Sin antivirus delante, estas dos cabeceras son la red de seguridad de
    // servir un fichero de terceros desde nuestro propio origen: `nosniff`
    // impide que el navegador reinterprete los bytes como otra cosa, y el
    // sandbox deja el documento sin origen. Ver docs/security/adjuntos-sin-antivirus.md.
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'"
  };
  return stream
    ? new Response(stream, { headers })
    : new Response(new Uint8Array(bytes ?? []), { headers });
};
