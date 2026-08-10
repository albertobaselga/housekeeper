/**
 * Salida de correo de los trabajos de la cola.
 *
 * Vivía dentro de `integrations.ts` junto al OCR, el redimensionado de imágenes
 * y las notificaciones push. Se separó cuando el drenaje de la cola pasó a
 * ejecutarse también desde la web (apps/web/src/lib/server/job-runner.server.ts):
 * importar `integrations.ts` allí arrastraba `sharp` y `tesseract.js` —binario
 * nativo y modelo de OCR— al paquete de la función serverless, para poder mandar
 * un correo de texto plano. `integrations.ts` re-exporta todo lo de aquí, así
 * que nada de lo que ya importaba cambia.
 */
import nodemailer from "nodemailer";

/** Lo que necesita el transporte SMTP; espejo de `WorkerConfig["smtp"]`. */
export interface SmtpConfig {
  host: string;
  port: number;
  from: string;
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

export async function sendEmail(config: SmtpConfig, input: OutgoingEmail): Promise<void> {
  const guarded = applySyntheticEmailPolicy(input, isSyntheticOnly());
  const transport = nodemailer.createTransport({ host: config.host, port: config.port, secure: false });
  await transport.sendMail({ from: config.from, ...guarded });
}
