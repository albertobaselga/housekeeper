import { UploadAttachmentError, type UploadAttachmentErrorCode } from '$lib/attachments/upload';

/**
 * Vista previa de la foto de un cupón, SIN `blob:`.
 *
 * La CSP de la aplicación solo admite imágenes de `'self'` y `data:`
 * (`svelte.config.js`), así que `URL.createObjectURL` quedaría bloqueado. La
 * foto ya preparada (reencodada, sin EXIF) se dibuja pequeña en un lienzo y se
 * enseña como `data:`: pesa unas decenas de kilobytes y no sale del móvil.
 *
 * Devuelve null si el navegador no sabe dibujarla. No es un error: la foto se
 * sube igual y la ficha la enseñará desde la ruta con sesión.
 */
export async function photoPreview(file: Blob, maxEdge = 640): Promise<string | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  let bitmap: ImageBitmap;
  try {
    // `from-image`, como el redibujado que se sube (`prepare.ts`): hoy llega
    // la foto ya reencodada y derecha, pero si un día llegara el original, una
    // foto vertical del móvil no puede verse tumbada.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

/** Sin red no hay alta (D-offline): la foto se sube en el momento. */
export const PHOTO_OFFLINE_MESSAGE = 'Necesitas conexión para guardar la foto del cupón.';

export interface PhotoUploadProblem {
  message: string;
  /** ¿Sirve de algo «Volver a intentarlo» con la MISMA foto? */
  retry: boolean;
}

/**
 * Los fallos que se arreglan solos: sin red, un 5xx, el almacén caído. Los
 * demás (pesa demasiado, no es una imagen, no pasó la revisión, ya la subió
 * otra persona) se repetirían igual con la misma foto, y ofrecer reintentar
 * sería mandar a la persona a chocar otra vez contra lo mismo.
 */
const TRANSIENT: ReadonlySet<UploadAttachmentErrorCode> = new Set([
  'attachment_upload_failed',
  'attachments_unavailable'
]);

/** Lo que pasa después de cada fallo que no se arregla reintentando. */
const NEXT_STEP: Partial<Record<UploadAttachmentErrorCode, string>> = {
  attachment_duplicate: 'Mira si ya está en la cartera o hazle otra foto.'
};

/** Qué decir cuando la foto no se ha podido guardar, y si reintentar tiene sentido. */
export function photoUploadProblem(cause: unknown, offline: boolean): PhotoUploadProblem {
  if (offline) return { message: PHOTO_OFFLINE_MESSAGE, retry: true };
  if (cause instanceof UploadAttachmentError) {
    const next = NEXT_STEP[cause.code];
    return { message: next ? `${cause.message} ${next}` : cause.message, retry: TRANSIENT.has(cause.code) };
  }
  return { message: 'No se pudo guardar la foto. Vuelve a intentarlo.', retry: true };
}

export type PhotoPhase = 'empty' | 'preparing' | 'uploading' | 'ready' | 'failed';

/**
 * ¿Qué frena «Guardar los cambios» cuando se ha pedido cambiar la foto?
 *
 * · `busy`: la foto nueva aún se prepara o se sube; se espera.
 * · `failed`: la foto nueva no se ha guardado. Guardar sin ella cerraría la
 *   ficha con «Guardado ✓» y la foto VIEJA, cuando la persona pidió
 *   cambiarla: se dice y se le deja elegir (reintentar o quedarse la de antes).
 * · null: no se pidió, todavía no se ha elegido ninguna, o ya está guardada.
 */
export function photoChangeHold(changing: boolean, phase: PhotoPhase): 'busy' | 'failed' | null {
  if (!changing) return null;
  if (phase === 'preparing' || phase === 'uploading') return 'busy';
  if (phase === 'failed') return 'failed';
  return null;
}
