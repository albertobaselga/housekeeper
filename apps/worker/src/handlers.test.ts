import { describe, expect, it } from "vitest";

import { sha256 } from "./documents.js";
import { createRenderReceiptHandler, receiptObjectKey } from "./handlers.js";
import { PermanentJobError, type ClaimedJob } from "./queue.js";

const HOUSEHOLD = "10000000-0000-4000-8000-000000000001";

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
    const handler = createRenderReceiptHandler(async (key, body, contentType) => {
      uploads.push({ key, body, contentType });
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
    const handler = createRenderReceiptHandler(async () => {
      throw new Error("no debe subirse nada");
    });
    await expect(handler(renderJob({}))).rejects.toBeInstanceOf(PermanentJobError);
    await expect(handler(renderJob({ receipt: { reference: "x" } }))).rejects.toBeInstanceOf(PermanentJobError);
  });
});
