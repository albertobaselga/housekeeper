import { createHash } from "node:crypto";

import { strToU8, zipSync } from "fflate";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface ReceiptLine {
  concept: string;
  detail: string;
  amountCents: string;
}

export interface ReceiptInput {
  householdName: string;
  employeeName: string;
  period: string;
  generatedAt: string;
  lines: ReceiptLine[];
  salaryTotalCents: string;
  reimbursementTotalCents: string;
  transferTotalCents: string;
  reference: string;
}

const parseCents = (value: string): bigint => {
  if (!/^-?(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`Importe en céntimos inválido: ${value}`);
  }
  return BigInt(value);
};

export function formatEuroCents(value: string): string {
  const cents = parseCents(value);
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  const euros = absolute / 100n;
  const remainder = String(absolute % 100n).padStart(2, "0");
  const groupedEuros = euros.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${groupedEuros},${remainder} EUR`;
}

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
/** Por debajo de aquí solo va el pie; el contenido salta de hoja. */
const CONTENT_FLOOR = 76;
/** Lo que baja un concepto: 14 hasta su detalle y 23 hasta el siguiente. */
const LINE_HEIGHT = 37;
/**
 * Lo que mide el bloque de totales desde la raya separadora: 24 hasta «Salario
 * del mes», 20 hasta «Reembolso de gastos» y 28 hasta «Total a transferir».
 */
const TOTALS_BLOCK = 72;

/**
 * El recibo del mes, determinista: los mismos bytes para el mismo snapshot,
 * porque su sha-256 va dentro de la clave del objeto y de la fila que lo
 * registra como EL recibo de esa liquidación (migración 0035).
 *
 * Pagina, y no es un refinamiento. El payload trae UNA línea por concepto —el
 * salario, cada jornada extra, cada plazo de anticipo, cada gasto reembolsado—,
 * así que un mes movido pasa de largo la quincena de líneas que cabe en una
 * hoja. Cuando esto se dibujaba en una sola página el bloque de totales se
 * montaba encima del pie y, a partir de unas dieciocho líneas, se dibujaba con
 * la `y` en negativo: «Salario del mes», «Reembolso de gastos» y «Total a
 * transferir» NO salían en el PDF, sin aviso ni hueco que lo delatara. Y este
 * es el papel que la empleada se descarga como su recibo archivado.
 *
 * Paginar no reescribió los recibos que ya estaban bien: un mes que cabía en
 * una hoja sale byte a byte igual que antes —mismo sha-256, misma clave de
 * objeto—, así que solo cambian los que se rompían.
 */
export async function renderReceiptPdf(input: ReceiptInput): Promise<Uint8Array> {
  const generatedAt = new Date(input.generatedAt);
  if (Number.isNaN(generatedAt.getTime())) throw new TypeError("generatedAt inválido");

  const document = await PDFDocument.create({ updateMetadata: false });
  document.setTitle(`Recibo informativo ${input.period}`);
  document.setAuthor(input.householdName);
  document.setCreator("Gestión del personal doméstico (worker)");
  document.setProducer("Gestión del personal doméstico (worker)");
  document.setCreationDate(generatedAt);
  document.setModificationDate(generatedAt);

  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  let page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - 54;

  /** Salta de hoja si lo siguiente no cabe entero por encima del pie. */
  const ensure = (space: number): void => {
    if (y - space >= CONTENT_FLOOR) return;
    page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - 54;
  };

  // Membrete: la casa que emite el documento, no el nombre del proyecto.
  page.drawText(input.householdName.toLocaleUpperCase("es"), {
    x: 48,
    y,
    size: 11,
    font: bold,
    color: rgb(0.08, 0.32, 0.27),
  });
  y -= 30;
  page.drawText(`Recibo informativo · ${input.period}`, { x: 48, y, size: 19, font: bold });
  y -= 22;
  page.drawText(input.employeeName, { x: 48, y, size: 10, font: regular });
  y -= 28;
  page.drawText("Documento doméstico no oficial", {
    x: 48,
    y,
    size: 10,
    font: bold,
    color: rgb(0.64, 0.28, 0.06),
  });
  y -= 34;

  for (const line of input.lines) {
    // El concepto y su detalle no se separan: el importe está arriba y la
    // explicación de dónde sale, debajo.
    ensure(LINE_HEIGHT);
    page.drawText(line.concept.slice(0, 48), { x: 48, y, size: 10, font: bold });
    page.drawText(formatEuroCents(line.amountCents), { x: 430, y, size: 10, font: regular });
    y -= 14;
    page.drawText(line.detail.slice(0, 78), { x: 48, y, size: 8, font: regular, color: rgb(0.35, 0.35, 0.35) });
    y -= 23;
  }

  // El bloque de totales se reserva ENTERO antes de dibujar la raya. Partirlo
  // sería casi tan malo como perderlo: una raya al pie de una hoja y el total
  // solo en la siguiente hace dudar de si ese total es de esta cuenta. Los 24
  // de más sobre lo que mide el bloque lo separan del pie en vez de pegarlo.
  ensure(TOTALS_BLOCK + 24);
  page.drawLine({ start: { x: 48, y }, end: { x: 547, y }, thickness: 1 });
  y -= 24;
  page.drawText("Salario del mes", { x: 48, y, size: 10, font: regular });
  page.drawText(formatEuroCents(input.salaryTotalCents), { x: 430, y, size: 10, font: bold });
  y -= 20;
  page.drawText("Reembolso de gastos", { x: 48, y, size: 10, font: regular });
  page.drawText(formatEuroCents(input.reimbursementTotalCents), { x: 430, y, size: 10, font: bold });
  y -= 28;
  page.drawText("Total a transferir", { x: 48, y, size: 13, font: bold });
  page.drawText(formatEuroCents(input.transferTotalCents), { x: 414, y, size: 13, font: bold });

  // El pie va en TODAS las hojas, y por eso se dibuja al final, cuando ya se
  // sabe cuántas hay: una segunda página sin referencia es un papel suelto que
  // no se puede casar con su liquidación.
  for (const sheet of document.getPages()) {
    sheet.drawText(`Referencia: ${input.reference}`, { x: 48, y: 56, size: 8, font: regular });
    sheet.drawText(`Generado: ${input.generatedAt}`, { x: 48, y: 43, size: 8, font: regular });
  }

  return document.save({ addDefaultPage: false, objectsPerTick: Number.POSITIVE_INFINITY, useObjectStreams: false });
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildEmployeeExport(files: Record<string, Uint8Array | string>): Uint8Array {
  const entries = Object.fromEntries(
    Object.entries(files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, typeof value === "string" ? strToU8(value) : value]),
  );
  return zipSync(entries, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") });
}
