import { describe, expect, it } from "vitest";

import { sha256 } from "./documents.js";
import { createRenderReceiptHandler, receiptObjectKey } from "./handlers.js";
import { PermanentJobError, type ClaimedJob } from "./queue.js";

const HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const SETTLEMENT = "12b00000-0000-4000-8000-000000000001";

function renderJob(payload: unknown): ClaimedJob {
  return { id: "job-1", householdId: HOUSEHOLD, type: "document.render_receipt", payload, attempts: 1 };
}

function receiptPayload() {
  return {
    receipt: {
      householdName: "Fixture Casa Roble",
      employeeName: "Fixture Empleada",
      period: "Marzo 2025",
      generatedAt: "2025-03-28T18:00:00.000Z",
      lines: [
        { concept: "Salario base", detail: "Acuerdo v1", amountCents: "140000" },
        { concept: "Anticipo", detail: "Cuota de marzo", amountCents: "-10000" },
      ],
      salaryTotalCents: "140530",
      reimbursementTotalCents: "4800",
      transferTotalCents: "145330",
      reference: "REC-2025-03/Roble",
    },
  };
}

describe("handler de render de recibo", () => {
  it("sube un PDF determinista bajo una clave con hash del contenido", async () => {
    const uploads: Array<{ key: string; body: Uint8Array; contentType: string }> = [];
    const handler = createRenderReceiptHandler({
      upload: async (key, body, contentType) => {
        uploads.push({ key, body, contentType });
      },
    });

    await handler(renderJob(receiptPayload()));
    await handler(renderJob(receiptPayload()));

    expect(uploads).toHaveLength(2);
    const [first, second] = uploads as [typeof uploads[number], typeof uploads[number]];
    expect(first.contentType).toBe("application/pdf");
    expect(first.key).toBe(second.key);
    expect(sha256(first.body)).toBe(sha256(second.body));
    expect(first.key).toBe(receiptObjectKey(HOUSEHOLD, "REC-2025-03/Roble", sha256(first.body)));
    expect(first.key).toMatch(/^[a-f0-9-]+\/receipts\/rec-2025-03-roble-[a-f0-9]{16}\.pdf$/);
  });

  it("rechaza payloads inválidos como fallo permanente sin subir nada", async () => {
    const handler = createRenderReceiptHandler({
      upload: async () => {
        throw new Error("no debe subirse nada");
      },
    });
    await expect(handler(renderJob({}))).rejects.toBeInstanceOf(PermanentJobError);
    await expect(handler(renderJob({ receipt: { reference: "x" } }))).rejects.toBeInstanceOf(PermanentJobError);
  });

  // El aviso a la empleada sale de AQUÍ y de ningún otro sitio: el momento en
  // que su recibo existe es el único en que la aplicación le escribe al móvil.
  it("anuncia el recibo solo después de subirlo, y solo si el trabajo trae la liquidación", async () => {
    const order: string[] = [];
    const announced: Array<{ householdId: string; settlementId: string }> = [];
    const handler = createRenderReceiptHandler({
      upload: async () => {
        order.push("upload");
      },
      announceReceipt: async (input) => {
        order.push("announce");
        announced.push(input);
      },
    });

    await handler(renderJob({ ...receiptPayload(), settlementId: SETTLEMENT }));

    expect(order).toEqual(["upload", "announce"]);
    expect(announced).toEqual([{ householdId: HOUSEHOLD, settlementId: SETTLEMENT }]);

    // Un recibo encolado por la versión anterior no lleva `settlementId`. Tiene
    // que generarse igual: lo único que no tendrá es aviso.
    await handler(renderJob(receiptPayload()));
    expect(announced).toHaveLength(1);
    expect(order).toEqual(["upload", "announce", "upload"]);
  });

  it("no anuncia nada si el PDF no llegó a subirse", async () => {
    const announced: string[] = [];
    const handler = createRenderReceiptHandler({
      upload: async () => {
        throw new Error("el almacén no responde");
      },
      announceReceipt: async ({ settlementId }) => {
        announced.push(settlementId);
      },
    });

    await expect(
      handler(renderJob({ ...receiptPayload(), settlementId: SETTLEMENT })),
    ).rejects.toThrow("el almacén no responde");
    // «Ya está tu recibo» con el recibo sin subir es mentira, y además la
    // llevaría a una pantalla que no puede enseñárselo.
    expect(announced).toEqual([]);
  });
});
