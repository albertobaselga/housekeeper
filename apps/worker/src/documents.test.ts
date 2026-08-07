import { describe, expect, it } from "vitest";

import { buildEmployeeExport, formatEuroCents, renderReceiptPdf, sha256 } from "./documents.js";
import { createWhatsAppLink } from "./integrations.js";

const receipt = {
  householdName: "Casa Roble",
  employeeName: "Ana Demo",
  period: "2026-03",
  generatedAt: "2026-03-31T18:00:00.000Z",
  reference: "CC-2026-03-DEMO",
  salaryTotalCents: "140600",
  reimbursementTotalCents: "4730",
  transferTotalCents: "145330",
  lines: [
    { concept: "Salario acordado", detail: "Versión vigente en marzo", amountCents: "140000" },
    { concept: "Libranza trabajada", detail: "09/03 · tarifa congelada", amountCents: "7000" },
    { concept: "Horas extra", detail: "3 h × 12,00 EUR", amountCents: "3600" },
    { concept: "Descuento anticipo", detail: "Plan de 100,00 EUR", amountCents: "-10000" },
    { concept: "Reembolso", detail: "2 justificantes", amountCents: "4730" },
  ],
};

describe("documentos del worker", () => {
  it("genera el mismo PDF y hash para el mismo snapshot", async () => {
    const first = await renderReceiptPdf(receipt);
    const second = await renderReceiptPdf(receipt);
    expect(first.length).toBeGreaterThan(1_000);
    expect(sha256(first)).toBe(sha256(second));
  });

  it("conserva los céntimos y el signo", () => {
    expect(formatEuroCents("145330")).toBe("1.453,30 EUR");
    expect(formatEuroCents("-10000")).toBe("-100,00 EUR");
  });

  it("produce exportaciones zip reproducibles", () => {
    const first = buildEmployeeExport({ "historico.csv": "periodo,total\n2026-03,145330\n" });
    const second = buildEmployeeExport({ "historico.csv": "periodo,total\n2026-03,145330\n" });
    expect(sha256(first)).toBe(sha256(second));
  });

  it("solo crea enlaces WhatsApp iniciados por la persona", () => {
    expect(createWhatsAppLink("+34 600 123 123", "Revisar menú"))
      .toBe("https://wa.me/34600123123?text=Revisar%20men%C3%BA");
  });
});
