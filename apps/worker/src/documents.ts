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

export async function renderReceiptPdf(input: ReceiptInput): Promise<Uint8Array> {
  const generatedAt = new Date(input.generatedAt);
  if (Number.isNaN(generatedAt.getTime())) throw new TypeError("generatedAt inválido");

  const document = await PDFDocument.create({ updateMetadata: false });
  document.setTitle(`Recibo informativo ${input.period}`);
  document.setAuthor("Casa Clara");
  document.setCreator("Casa Clara worker");
  document.setProducer("Casa Clara worker");
  document.setCreationDate(generatedAt);
  document.setModificationDate(generatedAt);

  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const page = document.addPage([595.28, 841.89]);
  const { height } = page.getSize();
  let y = height - 54;

  page.drawText("CASA CLARA", { x: 48, y, size: 11, font: bold, color: rgb(0.08, 0.32, 0.27) });
  y -= 30;
  page.drawText(`Recibo informativo · ${input.period}`, { x: 48, y, size: 19, font: bold });
  y -= 22;
  page.drawText(`${input.employeeName} · ${input.householdName}`, { x: 48, y, size: 10, font: regular });
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
    page.drawText(line.concept.slice(0, 48), { x: 48, y, size: 10, font: bold });
    page.drawText(formatEuroCents(line.amountCents), { x: 430, y, size: 10, font: regular });
    y -= 14;
    page.drawText(line.detail.slice(0, 78), { x: 48, y, size: 8, font: regular, color: rgb(0.35, 0.35, 0.35) });
    y -= 23;
  }

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

  page.drawText(`Referencia: ${input.reference}`, { x: 48, y: 56, size: 8, font: regular });
  page.drawText(`Generado: ${input.generatedAt}`, { x: 48, y: 43, size: 8, font: regular });

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
