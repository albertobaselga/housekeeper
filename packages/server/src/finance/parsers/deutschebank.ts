import * as XLSX from "xlsx";

import { normalizeBankProvider, type ParsedRow } from "@housekeeper/domain/finance";

import { FinanceParserError, balanceCentsOf, buildRaw, parseDateEs, toCents } from "./shared.js";

const PREFIXES: readonly [RegExp, string][] = [
  [/^RECIBO\s+/, ""],
  [/^NOM\.EX-\d+\s+A\s+/, "NOMINA "],
  [/^TRANSFERENCIA\s+(A FAVOR DE\s+|DE\s+)?/, ""],
];

function dbProvider(concept: string): string {
  for (const [rx, prefix] of PREFIXES) {
    const m = rx.exec(concept);
    if (m !== null) return (prefix + concept.slice(m[0].length)).trim().slice(0, 200);
  }
  return concept.trim().slice(0, 200);
}

/** Port de parsers/deutschebank.py::parse sobre SheetJS. */
export function parseDeutsche(bytes: Uint8Array): ParsedRow[] {
  const wb = XLSX.read(bytes, { type: "array" });
  const first = wb.SheetNames[0];
  if (first === undefined) throw new FinanceParserError("libro sin hojas", 0);
  const grid: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[first] as XLSX.WorkSheet, {
    header: 1,
    raw: true,
    defval: "",
  });
  const text = (row: unknown[], i: number): string => String(row[i] ?? "").trim();
  let iban: string | null = null;
  let headerRow: number | null = null;
  let headers: string[] = [];
  for (let r = 0; r < grid.length; r += 1) {
    const cells = (grid[r] as unknown[]).map((c) => String(c ?? "").trim());
    if (cells[1] === "Cuenta:") iban = cells[2]?.trim() || null; // "" no es un IBAN válido
    if (cells[1] === "date" && cells.includes("amount")) {
      headerRow = r;
      headers = cells;
      break;
    }
  }
  if (iban === null || headerRow === null) {
    throw new FinanceParserError("no se encontró el IBAN o la cabecera de la tabla", 0);
  }
  const rows: ParsedRow[] = [];
  for (let r = headerRow + 1; r < grid.length; r += 1) {
    const cells = grid[r] as unknown[];
    if (text(cells, 1) === "") continue;
    const concept = text(cells, 3);
    const amount = toCents(cells[8]);
    if (amount === null) throw new FinanceParserError(`importe vacío en ${JSON.stringify(concept)}`, r);
    rows.push({
      accountRef: iban,
      bankRef: iban,
      opDate: parseDateEs(text(cells, 1), r),
      valueDate: text(cells, 2) !== "" ? parseDateEs(text(cells, 2), r) : null,
      concept,
      provider: normalizeBankProvider({
        provider: dbProvider(concept),
        concept,
        codeCommon: null,
        codeOwn: null,
        bank: "deutsche_bank",
      }),
      amountCents: amount,
      balanceCents: balanceCentsOf(cells[9], r), // vacío → null; ilegible → error
      codeCommon: null,
      codeOwn: null,
      dedupRef: null,
      bankCategory: null,
      raw: buildRaw(headers, cells),
    });
  }
  if (rows.length === 0) {
    throw new FinanceParserError("fichero de Deutsche Bank sin movimientos", headerRow);
  }
  return rows;
}
