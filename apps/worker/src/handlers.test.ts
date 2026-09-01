import { describe, expect, it } from "vitest";

import { renderReceiptPdf, sha256 } from "./documents.js";
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

  // Frente E: el recibo queda registrado (app.settlement_receipts) tras subirlo
  // y antes de anunciarlo, y solo cuando el trabajo trae `settlementId`.
  it("registra el recibo tras subirlo y antes de anunciarlo", async () => {
    const order: string[] = [];
    const recorded: Array<{ settlementId: string; objectKey: string; sha256: string; byteSize: number }> = [];
    const handler = createRenderReceiptHandler({
      upload: async () => {
        order.push("upload");
      },
      recordReceipt: async (input) => {
        order.push("record");
        recorded.push(input);
      },
      announceReceipt: async () => {
        order.push("announce");
      },
    });

    await handler(renderJob({ ...receiptPayload(), settlementId: SETTLEMENT }));

    expect(order).toEqual(["upload", "record", "announce"]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.settlementId).toBe(SETTLEMENT);
    expect(recorded[0]?.objectKey).toBe(
      receiptObjectKey(HOUSEHOLD, "REC-2025-03/Roble", sha256(await renderReceiptPdf(receiptPayload().receipt))),
    );
    expect(recorded[0]?.byteSize).toBeGreaterThan(0);
  });

  it("si falla la subida no registra el recibo", async () => {
    const recorded: unknown[] = [];
    const handler = createRenderReceiptHandler({
      upload: async () => {
        throw new Error("el almacén no responde");
      },
      recordReceipt: async (input) => {
        recorded.push(input);
      },
    });

    await expect(
      handler(renderJob({ ...receiptPayload(), settlementId: SETTLEMENT })),
    ).rejects.toThrow("el almacén no responde");
    expect(recorded).toEqual([]);
  });

  // Frente E, corrección de revisión: `recordReceipt` puede fallar por un
  // motivo de NEGOCIO, no solo por una avería. `55000` es una liquidación que
  // ya no está cerrada —p. ej. se anuló justo después de encolar este
  // render—: el comportamiento correcto es completar en silencio, sin
  // registrar ni anunciar, y sin reintentar (reintentar solo volvería a
  // chocar con la misma liquidación anulada).
  it("si recordReceipt falla con 55000 (liquidación anulada) el trabajo completa en silencio", async () => {
    const order: string[] = [];
    const announced: unknown[] = [];
    const handler = createRenderReceiptHandler({
      upload: async () => {
        order.push("upload");
      },
      recordReceipt: async () => {
        order.push("record");
        const error = new Error("la liquidación ya no está cerrada") as Error & { code: string };
        error.code = "55000";
        throw error;
      },
      announceReceipt: async () => {
        order.push("announce");
        announced.push(true);
      },
    });

    await expect(
      handler(renderJob({ ...receiptPayload(), settlementId: SETTLEMENT })),
    ).resolves.toBeUndefined();
    // Subió (el PDF ya está en el almacén, huérfano y sin problema) pero ni
    // registró de verdad ni anunció nada: silencio limpio.
    expect(order).toEqual(["upload", "record"]);
    expect(announced).toEqual([]);
  });

  // `22023` es una liquidación que no existe en absoluto: fallo permanente,
  // no un contratiempo del día. Reintentar no lo arreglaría.
  it("si recordReceipt falla con 22023 (liquidación inexistente) es un fallo permanente", async () => {
    const announced: unknown[] = [];
    const handler = createRenderReceiptHandler({
      upload: async () => {},
      recordReceipt: async () => {
        const error = new Error("la liquidación no existe") as Error & { code: string };
        error.code = "22023";
        throw error;
      },
      announceReceipt: async () => {
        announced.push(true);
      },
    });

    await expect(
      handler(renderJob({ ...receiptPayload(), settlementId: SETTLEMENT })),
    ).rejects.toBeInstanceOf(PermanentJobError);
    expect(announced).toEqual([]);
  });

  // Cualquier otro código (avería del día: la base no responde, etc.) sigue
  // tumbando el trabajo para que la cola lo reintente entero.
  it("cualquier otro fallo de recordReceipt sigue reintentando el trabajo entero", async () => {
    const handler = createRenderReceiptHandler({
      upload: async () => {},
      recordReceipt: async () => {
        throw new Error("la base no responde");
      },
    });

    await expect(
      handler(renderJob({ ...receiptPayload(), settlementId: SETTLEMENT })),
    ).rejects.toThrow("la base no responde");
  });

  it("sin settlementId no registra ni anuncia (recibos encolados por la versión anterior)", async () => {
    const recorded: unknown[] = [];
    const announced: unknown[] = [];
    const handler = createRenderReceiptHandler({
      upload: async () => {},
      recordReceipt: async (input) => {
        recorded.push(input);
      },
      announceReceipt: async (input) => {
        announced.push(input);
      },
    });

    await handler(renderJob(receiptPayload()));

    expect(recorded).toEqual([]);
    expect(announced).toEqual([]);
  });
});
