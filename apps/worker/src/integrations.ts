import sharp from "sharp";
import { createWorker } from "tesseract.js";
import webPush from "web-push";

// El correo y el almacén de objetos viven en módulos propios (mail.ts,
// object-store.ts) para que el drenaje de la cola desde la web pueda usarlos sin
// arrastrar `sharp` ni `tesseract.js`. Se re-exportan aquí para no romper a
// nadie que ya los importase desde este fichero.
export {
  SYNTHETIC_EMAIL_DOMAINS,
  applySyntheticEmailPolicy,
  isSyntheticOnly,
  sendEmail,
  type OutgoingEmail,
  type SmtpConfig,
} from "./mail.js";
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

export async function sendWebPush(input: {
  vapid: { subject: string; publicKey: string; privateKey: string };
  subscription: webPush.PushSubscription;
  payload: Readonly<Record<string, string>>;
}): Promise<void> {
  webPush.setVapidDetails(input.vapid.subject, input.vapid.publicKey, input.vapid.privateKey);
  await webPush.sendNotification(input.subscription, JSON.stringify(input.payload), {
    TTL: 300,
    urgency: "high",
  });
}
