import * as XLSX from "xlsx";

import type { ParsedRow } from "@housekeeper/domain/finance";

// AMEX_SHEET viene de `shared.js`, nunca de `./index.js`: importarla del barrel
// crearía un ciclo index ↔ amex (index importa parseAmex de este fichero).
import { AMEX_SHEET, FinanceParserError, buildRaw, parseDateEs, sheetGrid, toCents } from "./shared.js";

const compact = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Port de parsers/amex.py::parse sobre SheetJS (signo invertido, ref obligatoria). */
export function parseAmex(bytes: Uint8Array): ParsedRow[] {
  const wb = XLSX.read(bytes, { type: "array" });
  if (!wb.SheetNames.includes(AMEX_SHEET)) {
    throw new FinanceParserError("no se encontró la hoja 'Detalles de la operación'", 0);
  }
  const grid = sheetGrid(wb, AMEX_SHEET);
  let bankRef: string | null = null;
  let headerIdx: number | null = null;
  let cols: Record<string, number> = {};
  let headers: string[] = [];
  let expectRef = false;
  for (let i = 0; i < grid.length; i += 1) {
    const row = grid[i] as unknown[];
    const first = String(row[0] ?? "").trim();
    if (expectRef && first !== "") {
      bankRef = first;
      expectRef = false;
    }
    if (first === "Número de Cuenta") expectRef = true;
    if (first === "Fecha") {
      const names = row.map((c) => String(c ?? "").trim());
      if (names.includes("Importe")) {
        cols = Object.fromEntries(names.map((nm, j) => [nm, j]).filter(([nm]) => nm !== ""));
        headers = names;
        headerIdx = i;
        break;
      }
    }
  }
  if (bankRef === null || headerIdx === null || !("Descripción" in cols)) {
    throw new FinanceParserError("no se encontró el número de cuenta o la cabecera de la tabla", 0);
  }
  const out: ParsedRow[] = [];
  for (let i = headerIdx + 1; i < grid.length; i += 1) {
    const row = grid[i] as unknown[];
    const cell = (name: string): string =>
      name in cols ? String(row[cols[name] as number] ?? "").trim() : "";
    if (cell("Fecha") === "") continue;
    const concept = cell("Descripción");
    const amount = toCents(row[cols["Importe"] as number]);
    if (amount === null) throw new FinanceParserError(`importe vacío en ${JSON.stringify(concept)}`, i);
    const ref = cell("Referencia");
    if (ref === "") throw new FinanceParserError(`referencia vacía en ${JSON.stringify(concept)}`, i);
    const categoria = cell("Categoría");
    out.push({
      accountRef: bankRef,
      bankRef,
      opDate: parseDateEs(cell("Fecha"), i),
      valueDate: null,
      concept,
      provider: compact(concept).slice(0, 200),
      amountCents: -amount, // convención Amex invertida: cargo positivo en fichero
      balanceCents: null,
      codeCommon: null,
      codeOwn: null,
      dedupRef: ref,
      bankCategory: categoria === "" ? null : categoria,
      raw: buildRaw(headers, row),
    });
  }
  if (out.length === 0) throw new FinanceParserError("fichero de Amex sin movimientos", headerIdx);
  return out;
}
