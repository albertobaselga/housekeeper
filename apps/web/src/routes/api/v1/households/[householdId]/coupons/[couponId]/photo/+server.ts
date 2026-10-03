import { error } from '@sveltejs/kit';

import { can } from '$lib/auth/capabilities';
import { membershipIn } from '$lib/auth/membership';
import { createAttachmentDependencies } from '$lib/server/attachment-deps.server';
import { loadCouponPhoto } from '$lib/server/coupon-photo.server';
import type { RequestHandler } from './$types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lo único que puede ser la foto de un cupón, con su extensión. Más estrecha
 * que la lista de adjuntos: un cupón no se fotografía en PDF, y la regla de
 * enlace (commands/coupon.ts y `coupons_photo_link`) tampoco lo deja colgar.
 */
const COUPON_PHOTO_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp'
};

/** La misma respuesta para «no existe», «no es tuyo» y «no es de tu papel». */
const NOT_FOUND = 'Ese cupón no tiene foto que enseñar';

/**
 * Ver la foto de un cupón (spec cupones §7.3). Calcado de
 * `receipts/[expenseId]/+server.ts`, con la comprobación de bucket de
 * `settlements/[settlementId]/receipt/+server.ts`. Solo lectura, en flujo y
 * por este origen: nunca una URL pública ni firmada del almacén.
 *
 * El hook NO protege `/api`, así que todo se comprueba aquí: sesión,
 * pertenencia al hogar y la capacidad del módulo. La empleada, el apoyo y el
 * acceso puntual reciben el MISMO 404 que un cupón que no existe —ni siquiera
 * llegan a la base—, y la RLS lo repite debajo: sin cupón visible no hay
 * objeto visible (0039).
 *
 * Aquí no se registra nada del cupón. Ni comercio, ni código, ni oferta: el
 * cargador ni siquiera los lee, y el nombre del fichero se compone con el id.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) error(401, 'Inicia sesión para ver la foto del cupón');
  const membership = membershipIn(locals.user, params.householdId);
  if (!membership || !can(membership.role, 'coupon.access')) error(404, NOT_FOUND);
  // Un id que no es un uuid no puede ser un cupón; sin esto, la base lo
  // rechazaría con un error de sintaxis que saldría como avería (503).
  if (!UUID_PATTERN.test(params.couponId)) error(404, NOT_FOUND);

  const photo = await loadCouponPhoto({ id: locals.user.id }, params.householdId, params.couponId);
  if (!photo) error(404, NOT_FOUND);

  const deps = createAttachmentDependencies();
  if (!deps) error(503, 'Ver la foto del cupón requiere el almacén de documentos del hogar');

  // La fila dice en qué bucket se subió la foto, y esta instalación puede
  // estar leyendo de OTRO (migración de almacén, entorno mal apuntado): en el
  // peor caso, la misma clave sería el objeto de otro inquilino del almacén
  // compartido. Se comprueba antes de leer nada.
  if (photo.bucket !== deps.bucket) {
    error(503, 'La foto del cupón está guardada en otro almacén distinto del que lee esta instalación');
  }

  // En flujo cuando el almacén lo permite: una función serverless no puede
  // devolver más de 4,5 MB materializados y una foto llega a 10 MiB.
  let stream: ReadableStream<Uint8Array> | null = null;
  let bytes: Uint8Array | null = null;
  try {
    if (deps.getObjectStream) stream = await deps.getObjectStream(photo.objectKey);
    else bytes = await deps.getObject(photo.objectKey);
  } catch {
    error(503, 'No se pudo recuperar la foto del cupón del almacén del hogar');
  }

  // El tipo sale de la lista blanca, no de la fila: aunque alguien lograse
  // escribir otra cosa en `media_type`, el navegador recibe una imagen o unos
  // bytes opacos que, con `nosniff`, no sabrá interpretar.
  const isImage = Object.hasOwn(COUPON_PHOTO_TYPES, photo.mediaType);
  const mediaType = isImage ? photo.mediaType : 'application/octet-stream';
  const extension = isImage ? COUPON_PHOTO_TYPES[photo.mediaType] : '';
  const headers = {
    'content-type': mediaType,
    'content-disposition': `inline; filename="cupon-${params.couponId}${extension}"`,
    'content-length': bytes ? String(bytes.length) : photo.byteSize,
    // La foto de un cupón lleva un código que vale dinero: ni en la caché del
    // navegador ni en la de nadie por el camino.
    'cache-control': 'private, no-store',
    // Sin antivirus delante, la red de seguridad de servir un fichero de
    // terceros desde nuestro propio origen: `nosniff` impide reinterpretar los
    // bytes y el sandbox deja el documento sin origen si alguien lo abre
    // directamente. Ver docs/security/adjuntos-sin-antivirus.md.
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
    // Solo la propia aplicación la incrusta en un <img>.
    'cross-origin-resource-policy': 'same-origin'
  };
  return stream
    ? new Response(stream, { headers })
    : new Response(new Uint8Array(bytes ?? []), { headers });
};
