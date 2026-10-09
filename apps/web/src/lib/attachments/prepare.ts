/**
 * Preparar la foto EN EL DISPOSITIVO antes de subirla.
 *
 * El motivo es concreto y medible: la cámara de un móvil moderno saca fotos de
 * 4 a 12 MB, y la función que recibe la subida en Vercel no acepta cuerpos de
 * más de 4,5 MB —eso lo corta la plataforma, antes de que nuestro código llegue
 * a opinar—. Sin este paso, «hacer una foto del ticket» falla justo con los
 * móviles buenos, que es exactamente al revés de lo que espera cualquiera.
 *
 * Reducir aquí también ahorra datos móviles y tiempo de subida a quien está en
 * la calle con el ticket en la mano.
 *
 * Este módulo se carga BAJO DEMANDA (`await import(...)`) desde la tarjeta de
 * gastos y desde el alta de cupones: quien nunca adjunta una foto no descarga
 * nada de esto.
 *
 * La foto de un cupón pide una cosa más (`alwaysReencode`): se vuelve a dibujar
 * SIEMPRE, pese lo que pese. Al pasar por el lienzo sale un JPEG nuevo, sin el
 * EXIF del original —ni la posición GPS de la tienda, ni el modelo del móvil, ni
 * la hora—, y con un nombre neutro. Esa foto la ve toda la familia; un tique de
 * gasto, no, y por eso allí se sigue subiendo tal cual cuando ya cabe.
 */

/**
 * Peso máximo que se manda. Deja margen sobre los 4,5 MB de Vercel para las
 * cabeceras y el sobre de la petición.
 */
export const UPLOAD_TARGET_BYTES = 3_500_000;

/** Lado mayor tras reducir: de sobra para leer el importe de un ticket. */
const MAX_IMAGE_EDGE = 2200;

/** Calidades JPEG que se prueban en orden hasta entrar en el objetivo. */
const QUALITY_STEPS = [0.82, 0.7, 0.55];

/**
 * Calidades para la foto que se reencoda siempre. Nunca por debajo de 0,8: el
 * código de un vale son a veces caracteres finos o un código de barras, y a
 * 0,55 los bordes se emborronan. Si a 0,8 no cabe, se reduce el LADO
 * (`REENCODE_EDGES`), que a 1.600 px sigue leyéndose de sobra.
 */
const REENCODE_QUALITY_STEPS = [0.9, 0.85, 0.8];
const REENCODE_EDGES = [MAX_IMAGE_EDGE, 1600, 1200];

export interface PrepareAttachmentOptions {
  /**
   * Reencodar SIEMPRE la imagen, aunque ya quepa: quita el EXIF (GPS incluido)
   * y el nombre original. Falla cerrado: si no se puede, lanza
   * `PrepareAttachmentError` en vez de dejar salir el original con sus datos.
   */
  alwaysReencode?: boolean;
}

/**
 * La foto no se ha podido preparar y, con `alwaysReencode`, NO se sube el
 * original. El mensaje está en el idioma de la interfaz y se enseña tal cual.
 */
export class PrepareAttachmentError extends Error {
  override readonly name = 'PrepareAttachmentError';
}

export interface PreparedAttachment {
  file: File;
  /**
   * Explicación en lenguaje llano de lo que ha pasado con la foto, o null si no
   * hubo que tocarla. La interfaz la enseña tal cual.
   */
  notice: string | null;
}

function isImage(file: File): boolean {
  return file.type.startsWith('image/');
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} MB`;
}

/** Nombre con extensión .jpg, conservando el original como raíz. */
function jpegName(name: string): string {
  const root = name.replace(/\.[^./\\]+$/, '') || 'justificante';
  return `${root}.jpg`;
}

async function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return await new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
  });
}

/**
 * Dibuja la imagen en un lienzo y la vuelve a codificar en JPEG, probando lados
 * y calidades en orden hasta entrar en `UPLOAD_TARGET_BYTES`. Devuelve el
 * primer resultado que cabe, o null si el navegador no puede descodificarla
 * (por ejemplo un HEIC que Safari no haya convertido) o si nada cabe.
 */
async function redrawImage(
  file: File,
  edges: readonly number[],
  qualities: readonly number[]
): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  let bitmap: ImageBitmap;
  try {
    // `from-image` aplica la orientación EXIF: sin esto, las fotos verticales de
    // muchos Android se subirían tumbadas.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  try {
    for (const edge of edges) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) return null;
      // Un JPEG no tiene transparencia: sin fondo, lo transparente de un PNG
      // sale NEGRO, y un vale con letra negra sobre fondo transparente se
      // quedaría en un rectángulo negro. Blanco, como el papel.
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of qualities) {
        const blob = await encode(canvas, quality);
        if (!blob) return null;
        if (blob.size <= UPLOAD_TARGET_BYTES) return blob;
      }
    }
    return null;
  } finally {
    bitmap.close();
  }
}

/**
 * Reduce una imagen hasta entrar en `UPLOAD_TARGET_BYTES`. Devuelve null si no
 * se puede: en ese caso se sube el original y que decida el servidor, que es
 * quien puede dar un motivo veraz.
 */
async function shrinkImage(file: File): Promise<File | null> {
  const blob = await redrawImage(file, [MAX_IMAGE_EDGE], QUALITY_STEPS);
  return blob ? new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: file.lastModified }) : null;
}

/**
 * La rama de `alwaysReencode`: un JPEG nuevo SIEMPRE, o un error. Nunca el
 * original: es justo el fichero que lleva el GPS dentro.
 */
async function reencodeImage(file: File): Promise<PreparedAttachment> {
  if (!isImage(file)) {
    throw new PrepareAttachmentError('Eso no es una foto. Elige una foto (JPG, PNG o WebP) o hazla ahora.');
  }
  const blob = await redrawImage(file, REENCODE_EDGES, REENCODE_QUALITY_STEPS);
  if (!blob) {
    throw new PrepareAttachmentError(
      'Este móvil no ha podido preparar la foto. Prueba a hacerla otra vez o elige otra en JPG o PNG.'
    );
  }
  // Nombre neutro: el de la cámara suele llevar la fecha y la hora de la foto.
  const reencoded = new File([blob], 'foto.jpg', { type: 'image/jpeg', lastModified: Date.now() });
  return {
    file: reencoded,
    notice:
      file.size > UPLOAD_TARGET_BYTES
        ? `La foto pesaba ${megabytes(file.size)} y se ha reducido a ${megabytes(reencoded.size)} para poder subirla. Se sigue leyendo bien.`
        : null
  };
}

/**
 * Deja el fichero listo para subir. Sin opciones solo toca las imágenes que
 * pesan de más: un PDF no se puede reducir sin romperlo, y una foto que ya cabe
 * se sube tal cual para no perder calidad sin motivo. Con `alwaysReencode`, la
 * imagen se vuelve a dibujar siempre (ver la cabecera del módulo).
 */
export async function prepareAttachment(
  file: File,
  options: PrepareAttachmentOptions = {}
): Promise<PreparedAttachment> {
  if (options.alwaysReencode) return await reencodeImage(file);
  if (file.size <= UPLOAD_TARGET_BYTES) return { file, notice: null };
  if (!isImage(file)) {
    return {
      file,
      notice: `Ese fichero pesa ${megabytes(file.size)} y puede que no llegue a subir. Si es un PDF, prueba con uno más ligero o hazle una foto.`
    };
  }
  const shrunk = await shrinkImage(file);
  if (!shrunk) {
    return {
      file,
      notice: `La foto pesa ${megabytes(file.size)} y este navegador no ha podido reducirla. Se intenta subir igualmente; si no cabe, hazla de nuevo con menos resolución.`
    };
  }
  return {
    file: shrunk,
    notice: `La foto pesaba ${megabytes(file.size)} y se ha reducido a ${megabytes(shrunk.size)} para poder subirla. Se sigue leyendo bien.`
  };
}
