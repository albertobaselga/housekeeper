import * as XLSX from "xlsx";

import type { FinanceBank } from "@housekeeper/domain/finance";

import { AMEX_SHEET, FinanceParserError } from "./shared.js";

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
  const first = wb.SheetNames[0];
  if (first === undefined) return null;
  const grid: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[first] as XLSX.WorkSheet, {
    header: 1,
    raw: true,
    defval: "",
  });
  for (const row of grid.slice(0, 15)) {
    for (const cell of row) {
      const v = String(cell).trim();
      if (v === "Número de cuenta") return "caixabank";
      if (v === "Cuenta:") return "deutsche_bank";
    }
  }
  return null;
}
