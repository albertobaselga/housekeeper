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
 * gastos: quien nunca adjunta una foto no descarga nada de esto.
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
 * Reduce una imagen hasta entrar en `UPLOAD_TARGET_BYTES`. Devuelve null si el
 * navegador no puede descodificarla (por ejemplo un HEIC que Safari no haya
 * convertido): en ese caso se sube el original y que decida el servidor, que es
 * quien puede dar un motivo veraz.
 */
async function shrinkImage(file: File): Promise<File | null> {
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
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of QUALITY_STEPS) {
      const blob = await encode(canvas, quality);
      if (!blob) return null;
      if (blob.size <= UPLOAD_TARGET_BYTES) {
        return new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
      }
    }
    return null;
  } finally {
    bitmap.close();
  }
}

/**
 * Deja el fichero listo para subir. Solo toca las imágenes que pesan de más:
 * un PDF no se puede reducir sin romperlo, y una foto que ya cabe se sube tal
 * cual para no perder calidad sin motivo.
 */
export async function prepareAttachment(file: File): Promise<PreparedAttachment> {
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
