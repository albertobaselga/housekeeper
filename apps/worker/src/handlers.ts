import { renderReceiptPdf, sha256, type ReceiptInput } from "./documents.js";
import { PermanentJobError, type JobHandler } from "./queue.js";

export const RENDER_RECEIPT_JOB = "document.render_receipt";

export interface DocumentUploader {
  (key: string, body: Uint8Array, contentType: string): Promise<void>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PermanentJobError(`El payload del recibo requiere ${field}`);
  }
  return value;
}

function parseReceiptPayload(payload: unknown): ReceiptInput {
  const candidate = (payload as { receipt?: unknown })?.receipt;
  if (!candidate || typeof candidate !== "object") {
    throw new PermanentJobError("El payload debe incluir el snapshot canónico en `receipt`");
  }
  const receipt = candidate as Record<string, unknown>;
  const rawLines = receipt.lines;
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new PermanentJobError("El recibo requiere al menos una línea");
  }
  return {
    householdName: requireString(receipt.householdName, "householdName"),
    employeeName: requireString(receipt.employeeName, "employeeName"),
    period: requireString(receipt.period, "period"),
    generatedAt: requireString(receipt.generatedAt, "generatedAt"),
    lines: rawLines.map((line, index) => {
      const entry = line as Record<string, unknown>;
      return {
        concept: requireString(entry.concept, `lines[${index}].concept`),
        detail: requireString(entry.detail, `lines[${index}].detail`),
        amountCents: requireString(entry.amountCents, `lines[${index}].amountCents`),
      };
    }),
    salaryTotalCents: requireString(receipt.salaryTotalCents, "salaryTotalCents"),
    reimbursementTotalCents: requireString(receipt.reimbursementTotalCents, "reimbursementTotalCents"),
    transferTotalCents: requireString(receipt.transferTotalCents, "transferTotalCents"),
    reference: requireString(receipt.reference, "reference"),
  };
}

export function receiptObjectKey(householdId: string, reference: string, hash: string): string {
  const safeReference = reference.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `${householdId}/receipts/${safeReference}-${hash.slice(0, 16)}.pdf`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * El identificador de la liquidación, si el trabajo lo trae.
 *
 * Opcional a propósito, y no por comodidad: cuando esto se despliegue puede
 * haber recibos ya encolados por la versión anterior, que no lo llevaban. Un
 * recibo viejo tiene que seguir generándose; lo único que no tendrá es aviso.
 * Exigirlo convertiría un despliegue en un puñado de PDF muertos.
 */
function optionalSettlementId(payload: unknown): string | null {
  const value = (payload as { settlementId?: unknown } | null | undefined)?.settlementId;
  return typeof value === "string" && UUID.test(value) ? value : null;
}

export interface RenderReceiptDeps {
  upload: DocumentUploader;
  /**
   * Encola el aviso de «tu recibo ya está» para la persona del contrato.
   *
   * **Este es el único momento en que se le avisa de algo.** No es una elección
   * de implementación: es la decisión del hogar. El recibo es lo suyo, aparece
   * una vez al mes, es una buena noticia y tiene una acción al otro lado
   * —mirarlo y confirmar el cobro—. Todo lo demás que la aplicación sabe de ella
   * se queda en la pantalla, que es donde se atiende.
   *
   * Va DESPUÉS de subir el PDF, y separado en su propio trabajo, por dos
   * razones: que un fallo del aviso no vuelva a renderizar y re-subir el recibo,
   * y que la ventana de silencio pueda aplazarlo sin aplazar el documento.
   */
  announceReceipt?: ((input: { householdId: string; settlementId: string }) => Promise<void>) | undefined;
}

/**
 * Renderiza el recibo determinista desde el snapshot canónico del payload y lo
 * sube al almacenamiento privado. El worker no lee tablas de dominio bajo RLS:
 * todo el contenido viaja en el job que encoló la aplicación al cerrar.
 */
export function createRenderReceiptHandler(deps: RenderReceiptDeps): JobHandler {
  return async (job) => {
    const receipt = parseReceiptPayload(job.payload);
    const pdf = await renderReceiptPdf(receipt);
    const hash = sha256(pdf);
    await deps.upload(
      receiptObjectKey(job.householdId, receipt.reference, hash),
      pdf,
      "application/pdf",
    );

    const settlementId = optionalSettlementId(job.payload);
    if (settlementId && deps.announceReceipt) {
      await deps.announceReceipt({ householdId: job.householdId, settlementId });
    }
  };
}
