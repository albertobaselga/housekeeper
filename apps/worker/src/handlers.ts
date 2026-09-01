import type { Pool } from "pg";

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
   * Registra el recibo (Frente E: `app_private.record_settlement_receipt`,
   * migración 0035) tras subirlo: sin esto el PDF existía en el almacén y en
   * ningún otro sitio, así que no había manera de descargarlo desde la
   * aplicación. Va DESPUÉS de `upload` y ANTES de `announceReceipt` — si el
   * registro falla, el trabajo se reintenta entero (re-renderizar el mismo
   * contenido es barato y determinista) y el aviso de «tu recibo ya está» no
   * debe salir con el recibo sin registrar: llevaría a una pantalla que no
   * puede enseñárselo.
   *
   * Igual que `announceReceipt`, solo aplica cuando el trabajo trae
   * `settlementId`: los recibos encolados por la versión anterior a este
   * frente siguen subiendo sin registrar — compatibilidad ya prevista por
   * `optionalSettlementId`.
   */
  recordReceipt?:
    | ((input: { settlementId: string; objectKey: string; sha256: string; byteSize: number }) => Promise<void>)
    | undefined;
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
    const key = receiptObjectKey(job.householdId, receipt.reference, hash);
    await deps.upload(key, pdf, "application/pdf");

    const settlementId = optionalSettlementId(job.payload);
    if (settlementId && deps.recordReceipt) {
      try {
        await deps.recordReceipt({ settlementId, objectKey: key, sha256: hash, byteSize: pdf.byteLength });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "55000") {
          // La liquidación ya no está cerrada (p. ej. se anuló después de
          // encolar este render): el PDF ya subido queda huérfano en el
          // almacén, y eso es inocuo. El trabajo se completa en silencio —ni
          // registro ni anuncio— y no hay nada que reintentar: reintentarlo
          // solo volvería a chocar con la misma liquidación anulada.
          return;
        }
        if (code === "22023") {
          // La liquidación no existe: fallo permanente, no un contratiempo del
          // día. Reintentar no lo arreglaría.
          throw new PermanentJobError(`La liquidación ${settlementId} no existe`);
        }
        throw error;
      }
    }
    if (settlementId && deps.announceReceipt) {
      await deps.announceReceipt({ householdId: job.householdId, settlementId });
    }
  };
}

/**
 * La consulta real sobre el pool del worker: una sola llamada a la función
 * definer de la 0035, que hace el upsert de `app.storage_objects`, inserta
 * `app.documents` y `app.settlement_receipts` en una sola transacción e
 * idempotente por su cuenta (ver la migración). El `bucket` no viaja aquí
 * dentro: lo cierra quien construye esta dependencia (`registry.ts`), que es
 * quien conoce el almacén configurado.
 */
export function createReceiptQueries(
  pool: Pool,
  bucket: string,
): { recordReceipt: NonNullable<RenderReceiptDeps["recordReceipt"]> } {
  return {
    recordReceipt: async ({ settlementId, objectKey, sha256: contentSha256, byteSize }) => {
      await pool.query("select app_private.record_settlement_receipt($1, $2, $3, $4, $5)", [
        settlementId,
        bucket,
        objectKey,
        contentSha256,
        byteSize,
      ]);
    },
  };
}
