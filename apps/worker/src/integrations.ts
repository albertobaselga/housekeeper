import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import nodemailer from "nodemailer";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import webPush from "web-push";

import type { WorkerConfig } from "./config.js";

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

export function objectStore(config: WorkerConfig["storage"]): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export async function putPrivateObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  if (!/^[a-f0-9-]+\/[a-z0-9/_-]+\.[a-z0-9]+$/i.test(key)) {
    throw new TypeError("Clave de objeto no autorizada");
  }
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

/** Dominios de prueba admitidos cuando el entorno es solo-sintético. */
export const SYNTHETIC_EMAIL_DOMAINS = [".demo", ".test", ".example", ".invalid"] as const;

/** Control 9 del baseline: ALLOW_SYNTHETIC_DATA_ONLY=true marca el entorno. */
export function isSyntheticOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALLOW_SYNTHETIC_DATA_ONLY === "true";
}

/**
 * Política de correo en entorno sintético: el asunto queda marcado con
 * [SINTÉTICO] y solo se admiten destinatarios cuyo dominio termine en un TLD
 * reservado de prueba (.demo/.test/.example/.invalid, RFC 2606/6761). Un
 * destinatario real se rechaza con un error claro que NO incluye la dirección.
 * Con el flag apagado la entrada pasa intacta.
 */
export function applySyntheticEmailPolicy(input: OutgoingEmail, syntheticOnly: boolean): OutgoingEmail {
  if (!syntheticOnly) return input;
  const at = input.to.lastIndexOf("@");
  const domain = at >= 0 ? input.to.slice(at + 1).trim().toLowerCase() : "";
  if (domain === "" || !SYNTHETIC_EMAIL_DOMAINS.some((tld) => domain.endsWith(tld))) {
    throw new Error(
      "Entorno solo-sintético (ALLOW_SYNTHETIC_DATA_ONLY=true): destinatario rechazado; " +
        `solo se admiten dominios de prueba (${SYNTHETIC_EMAIL_DOMAINS.join(", ")})`,
    );
  }
  return { ...input, subject: `[SINTÉTICO] ${input.subject}` };
}

export async function sendEmail(config: WorkerConfig["smtp"], input: OutgoingEmail): Promise<void> {
  const guarded = applySyntheticEmailPolicy(input, isSyntheticOnly());
  const transport = nodemailer.createTransport({ host: config.host, port: config.port, secure: false });
  await transport.sendMail({ from: config.from, ...guarded });
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
