import { inflateSync } from "node:zlib";

import { PDFDocument } from "pdf-lib";
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

/**
 * Un recibo con tantas líneas como conceptos tenga el mes. No es un caso
 * rebuscado: el payload trae una línea por concepto —el salario, cada jornada
 * extra, cada plazo de anticipo, cada gasto reembolsado—, así que un mes movido
 * llega a estas cifras sin esfuerzo.
 */
const receiptWithLines = (count: number) => ({
  ...receipt,
  lines: Array.from({ length: count }, (_, index) => ({
    concept: `Concepto ${index + 1}`,
    detail: `Detalle ${index + 1} · jornada del ${String((index % 28) + 1).padStart(2, "0")}/03`,
    amountCents: String(1000 + index),
  })),
});

/** Una cadena dibujada, con el sitio de la hoja donde cae. */
interface DrawnText {
  text: string;
  x: number;
  y: number;
}

/**
 * Lo que un PDF de pdf-lib dibuja de verdad, hoja a hoja y CON SUS COORDENADAS
 * (el lector de las suites de la web —`employment-export.integration.test.ts`—
 * ampliado con la posición).
 *
 * Dos capas que deshacer para afirmar sobre el documento y no sobre sus bytes:
 * los flujos de contenido van comprimidos con Flate, y dentro pdf-lib escribe
 * cada cadena como HEXADECIMAL (`<4C6120…> Tj`) precedida de su matriz de
 * texto (`1 0 0 1 x y Tm`). Se infla, se lee el hexadecimal como Latin-1 —que
 * es lo que WinAnsi es en su mayor parte— y se guarda junto a su `y`.
 *
 * La `y` no es un lujo: **pdf-lib escribe tan contento un `Tj` en y = -138**, y
 * esa cadena sigue estando en el flujo aunque no salga en ninguna hoja. Una
 * prueba que solo buscara el texto pasaría en verde contra el renderizador roto
 * —se comprobó— y no habría detectado nada. Lo que hay que afirmar es que el
 * total cae DENTRO del papel.
 */
function pdfSheets(bytes: Uint8Array): DrawnText[][] {
  const raw = Buffer.from(bytes);
  const sheets: DrawnText[][] = [];
  let cursor = 0;
  for (;;) {
    const start = raw.indexOf("stream", cursor);
    if (start === -1) break;
    const end = raw.indexOf("endstream", start);
    if (end === -1) break;
    cursor = end + "endstream".length;
    let from = start + "stream".length;
    if (raw[from] === 0x0d) from += 1;
    if (raw[from] === 0x0a) from += 1;
    let content: string;
    try {
      content = inflateSync(raw.subarray(from, end)).toString("latin1");
    } catch {
      // Un flujo que no es Flate: se salta.
      continue;
    }
    const drawn: DrawnText[] = [];
    for (const match of content.matchAll(
      /1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f\s]*)>\s*Tj/g,
    )) {
      drawn.push({
        x: Number(match[1]),
        y: Number(match[2]),
        text: Buffer.from(match[3]!.replace(/\s+/g, ""), "hex").toString("latin1"),
      });
    }
    sheets.push(drawn);
  }
  return sheets;
}

/** Todo lo dibujado en el documento, sin importar en qué hoja cae. */
const pdfDrawn = (bytes: Uint8Array): DrawnText[] => pdfSheets(bytes).flat();

const pageCount = async (bytes: Uint8Array): Promise<number> =>
  (await PDFDocument.load(bytes)).getPageCount();

/** El suelo del contenido y el pie, tal como los fija `renderReceiptPdf`. */
const CONTENT_FLOOR = 76;
const FOOTER_Y = [56, 43];

describe("documentos del worker", () => {
  it("genera el mismo PDF y hash para el mismo snapshot", async () => {
    const first = await renderReceiptPdf(receipt);
    const second = await renderReceiptPdf(receipt);
    expect(first.length).toBeGreaterThan(1_000);
    expect(sha256(first)).toBe(sha256(second));
  });

  it("cabe en una hoja cuando el mes es corto", async () => {
    const pdf = await renderReceiptPdf(receipt);
    expect(await pageCount(pdf)).toBe(1);
    const total = pdfDrawn(pdf).find((item) => item.text === "Total a transferir");
    expect(total?.y).toBeGreaterThanOrEqual(CONTENT_FLOOR);
  });

  /**
   * La regresión que importa. Con una sola hoja, cada concepto bajaba la `y` 37
   * puntos sin mirar nunca el suelo: a partir de unas dieciocho líneas el bloque
   * de totales se dibujaba con la `y` en negativo y NO salía en el papel. La
   * empleada se habría descargado su recibo archivado —el documento canónico,
   * según la migración 0035— sin el total, mientras el documento hermano del
   * mismo mes se lo enseñaba entero.
   *
   * Veinte y treinta conceptos no son una exageración: el payload trae una línea
   * por concepto y un mes con jornadas extra, plazos de anticipo y gastos las
   * junta sin esfuerzo.
   */
  it.each([20, 30])("dibuja el total dentro del papel con %i conceptos", async (count) => {
    const pdf = await renderReceiptPdf(receiptWithLines(count));
    const drawn = pdfDrawn(pdf);
    const shown = (text: string): DrawnText | undefined => drawn.find((item) => item.text === text);

    for (const label of ["Salario del mes", "Reembolso de gastos", "Total a transferir"]) {
      // Existir no basta: el flujo de contenido guarda tan tranquilo un `Tj` en
      // y negativa. Lo que se afirma es que cae por encima del pie.
      expect(shown(label)?.y).toBeGreaterThanOrEqual(CONTENT_FLOOR);
    }
    expect(shown(formatEuroCents(receipt.transferTotalCents))?.y).toBeGreaterThanOrEqual(
      CONTENT_FLOOR,
    );

    // Y ninguna línea se pierde por el camino: la primera y la última, dentro.
    expect(shown("Concepto 1")?.y).toBeGreaterThanOrEqual(CONTENT_FLOOR);
    expect(shown(`Concepto ${count}`)?.y).toBeGreaterThanOrEqual(CONTENT_FLOOR);

    expect(await pageCount(pdf)).toBeGreaterThan(1);
  });

  it("no escribe nada por debajo del suelo salvo el pie", async () => {
    for (const count of [4, 8, 12, 14, 15, 16, 18, 20, 30]) {
      const drawn = pdfDrawn(await renderReceiptPdf(receiptWithLines(count)));
      const intruders = drawn.filter(
        (item) => item.y < CONTENT_FLOOR && !FOOTER_Y.includes(item.y),
      );
      expect(intruders, `con ${count} conceptos`).toEqual([]);
    }
  });

  it("no parte el bloque de totales entre dos hojas", async () => {
    const sheets = pdfSheets(await renderReceiptPdf(receiptWithLines(30)));
    // Una raya al pie de una hoja y el total solo en la siguiente hace dudar de
    // si ese total es de esta cuenta: las tres cifras van juntas o no van.
    const together = sheets.filter((sheet) => {
      const texts = sheet.map((item) => item.text);
      return (
        texts.includes("Salario del mes") &&
        texts.includes("Reembolso de gastos") &&
        texts.includes("Total a transferir")
      );
    });
    expect(together).toHaveLength(1);
  });

  it("pone el pie en todas las hojas", async () => {
    const pdf = await renderReceiptPdf(receiptWithLines(30));
    const sheets = pdfSheets(pdf);
    expect(sheets.length).toBe(await pageCount(pdf));
    expect(sheets.length).toBeGreaterThan(1);
    for (const sheet of sheets) {
      const texts = sheet.map((item) => item.text);
      expect(texts).toContain(`Referencia: ${receipt.reference}`);
      expect(texts).toContain(`Generado: ${receipt.generatedAt}`);
    }
  });

  // El sha-256 del PDF va dentro de la clave del objeto y de la fila que lo
  // registra (migración 0035): paginar no puede haber traído nada que cambie de
  // un render a otro.
  it("sigue siendo byte a byte idéntico con varias hojas", async () => {
    const many = receiptWithLines(30);
    expect(sha256(await renderReceiptPdf(many))).toBe(sha256(await renderReceiptPdf(many)));
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
