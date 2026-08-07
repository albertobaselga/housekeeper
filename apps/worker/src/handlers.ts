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

/**
 * Renderiza el recibo determinista desde el snapshot canónico del payload y lo
 * sube al almacenamiento privado. El worker no lee tablas de dominio bajo RLS:
 * todo el contenido viaja en el job que encoló la aplicación al cerrar.
 */
export function createRenderReceiptHandler(upload: DocumentUploader): JobHandler {
  return async (job) => {
    const receipt = parseReceiptPayload(job.payload);
    const pdf = await renderReceiptPdf(receipt);
    const hash = sha256(pdf);
    await upload(receiptObjectKey(job.householdId, receipt.reference, hash), pdf, "application/pdf");
  };
}
