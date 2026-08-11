import sharp from "sharp";
import { createWorker } from "tesseract.js";

// El almacén de objetos vive en un módulo propio (object-store.ts) para que el
// drenaje de la cola desde la web pueda usarlo sin arrastrar `sharp` ni
// `tesseract.js`. Se re-exporta aquí para no romper a nadie que ya lo importase
// desde este fichero.
//
// Aquí se re-exportaba también `mail.ts`, el envío por SMTP con su política de
// entorno sintético. Se retiró entero con la migración 0029: no hay canal de
// correo y la aplicación no encola ya ningún trabajo que lo necesitara.
//
// Y aquí vivía `sendWebPush`, un envoltorio de `web-push` que no usaba ningún
// manejador: código muerto esperando a que alguien construyera el canal. Ya está
// construido, y vive en `push.ts` por la misma razón que el almacén vive en el
// suyo — el drenaje serverless no puede arrastrar binarios nativos—. De paso
// perdió dos defectos que tenía de nacimiento: `setVapidDetails` es estado
// global mutable del módulo, y `urgency: "high"` es justo lo contrario de lo que
// merece cualquier cosa que pase en esta casa.
export { objectStore, putPrivateObject, type ObjectStoreConfig } from "./object-store.js";

export function createWhatsAppLink(phone: string, message: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) throw new TypeError("Teléfono inválido");
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

export async function proposeReceiptAmount(image: Uint8Array): Promise<{
  amountCents: string | null;
  confidence: number;
  rawText: string;
}> {
  const worker = await createWorker("spa");
  try {
    const result = await worker.recognize(Buffer.from(image));
    const candidates = [...result.data.text.matchAll(/(?:total\s*)?(\d{1,6})[,.](\d{2})\s*(?:€|eur)?/gi)];
    const selected = candidates.at(-1);
    return {
      amountCents: selected ? `${selected[1]}${selected[2]}`.replace(/^0+(?=\d)/, "") : null,
      confidence: Math.max(0, Math.min(100, result.data.confidence)),
      rawText: result.data.text,
    };
  } finally {
    await worker.terminate();
  }
}

export async function normalizeImage(image: Uint8Array): Promise<Uint8Array> {
  return sharp(image, { failOn: "warning", limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 2_048, height: 2_048, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}
