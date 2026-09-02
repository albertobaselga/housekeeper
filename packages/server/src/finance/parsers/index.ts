import * as XLSX from "xlsx";

import type { FinanceBank, ParsedRow, ParsedStatement } from "@housekeeper/domain/finance";

import { parseAmex } from "./amex.js";
import { parseCaixabank } from "./caixabank.js";
import { parseDeutsche } from "./deutschebank.js";
import { parseOpenbank } from "./openbank.js";
import { AMEX_SHEET, CAIXABANK_HEADER_MARK, DEUTSCHE_HEADER_MARK, FinanceParserError, sheetGrid } from "./shared.js";

export { AMEX_SHEET, FinanceParserError };

function tryRead(bytes: Uint8Array): XLSX.WorkBook | null {
  try {
    return XLSX.read(bytes, { type: "array" });
  } catch {
    return null;
  }
}

/** Port de importer.detect_bank: SIEMPRE por contenido, nunca por extensión. */
export function detectBank(bytes: Uint8Array, filename: string): FinanceBank | null {
  void filename;
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // zip ⇒ .xlsx: solo Amex exporta xlsx
    const wb = tryRead(bytes);
    return wb !== null && wb.SheetNames.includes(AMEX_SHEET) ? "amex" : null;
  }
  const head = new TextDecoder("iso-8859-1").decode(bytes.slice(0, 4096));
  const stripped = head.replace(/^\s+/, "").toLowerCase();
  if (stripped.startsWith("<!doctype") || stripped.startsWith("<html")) {
    // OpenBank exporta HTML disfrazado de .xls
    return head.toUpperCase().includes("OPENBANK") ? "openbank" : null;
  }
  const wb = tryRead(bytes); // binario BIFF (.xls de verdad)
  if (wb === null) return null;
  let grid: unknown[][];
  try {
    grid = sheetGrid(wb);
  } catch {
    return null; // libro sin hojas: no es ningún banco reconocido
  }
  for (const row of grid.slice(0, 15)) {
    for (const cell of row) {
      const v = String(cell).trim();
      if (v === CAIXABANK_HEADER_MARK) return "caixabank";
      if (v === DEUTSCHE_HEADER_MARK) return "deutsche_bank";
    }
  }
  return null;
}

const PARSERS: Record<FinanceBank, (bytes: Uint8Array) => ParsedRow[]> = {
  caixabank: parseCaixabank,
  deutsche_bank: parseDeutsche,
  openbank: parseOpenbank,
  amex: parseAmex,
};

/** Detecta el banco y parsea el extracto completo. Lanza FinanceParserError. */
export function parseStatement(bytes: Uint8Array, filename: string): ParsedStatement {
  const bank = detectBank(bytes, filename);
  if (bank === null) {
    throw new FinanceParserError(
      `formato de ${filename} no reconocido (ni CaixaBank ni Deutsche Bank ni Amex ni OpenBank)`,
      0,
    );
  }
  const rows = PARSERS[bank](bytes);
  return { bank, accountRefs: [...new Set(rows.map((r) => r.accountRef))], rows };
}
