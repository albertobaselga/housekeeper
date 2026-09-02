import * as XLSX from "xlsx";

import { CARD_PREFIX_RX, normalizeBankProvider, type ParsedRow } from "@housekeeper/domain/finance";

import {
  CAIXABANK_HEADER_MARK,
  FinanceParserError,
  balanceCentsOf,
  buildRaw,
  parseDateEs,
  sheetGrid,
  toCents,
} from "./shared.js";

/** Port de parsers/caixabank.py::_extract_provider. */
function extractProvider(codeCommon: string, complementarios: readonly string[]): string {
  const joined = complementarios.map((c) => c.trim()).filter((c) => c !== "").join(" ");
  if (codeCommon === "11" || codeCommon === "12") {
    const m = CARD_PREFIX_RX.exec(joined);
    if (m !== null) {
      return (joined.slice(m.index + m[0].length).split("  ")[0] as string).trim().slice(0, 200);
    }
  }
  const first = complementarios.map((c) => c.trim()).find((c) => c !== "") ?? "";
  return first.replace(/\s{2,}.*$/, "").slice(0, 200);
}

/** Port de parsers/caixabank.py::parse sobre SheetJS. */
export function parseCaixabank(bytes: Uint8Array): ParsedRow[] {
  const wb = XLSX.read(bytes, { type: "array" });
  const grid = sheetGrid(wb);
  const text = (row: unknown[], i: number): string => String(row[i] ?? "").trim();
  const rows: ParsedRow[] = [];
  let inTable = false;
  let headers: string[] = [];
  grid.forEach((cells, r) => {
    if (text(cells, 1) === CAIXABANK_HEADER_MARK) {
      headers = cells.map((c) => String(c ?? "").trim());
      inTable = true;
      return;
    }
    if (!inTable) return;
    const rawRef = text(cells, 1);
    if (rawRef === "") {
      inTable = false; // fila en blanco: fin de tabla (puede empezar otra)
      return;
    }
    const bankRef = rawRef.replace(/ /g, "");
    if (!/^\d{20}$/.test(bankRef)) {
      throw new FinanceParserError(`número de cuenta inesperado ${JSON.stringify(rawRef)}`, r);
    }
    const ingreso = toCents(cells[6]);
    const gasto = toCents(cells[7]);
    if (ingreso === null && gasto === null) {
      throw new FinanceParserError("sin importe de ingreso ni gasto", r);
    }
    const amount = ingreso !== null ? ingreso : -(gasto as bigint);
    // `balanceCentsOf` distingue celda vacía (null legítimo) de celda ilegible
    // (error): el saldo entra en el hash de dedup y no puede caer a null en silencio.
    const saldoPos = balanceCentsOf(cells[8], r);
    const saldoNeg = balanceCentsOf(cells[9], r);
    const balance = saldoPos !== null ? saldoPos : saldoNeg !== null ? -saldoNeg : null;
    const codeCommon = text(cells, 10) || null;
    const codeOwn = text(cells, 11) || null;
    const complementarios = cells.slice(14, 24).map((c) => String(c ?? ""));
    const concept = [text(cells, 12), text(cells, 13), ...complementarios.map((c) => c.trim())]
      .filter((c) => c !== "")
      .join(" | ");
    rows.push({
      accountRef: bankRef,
      bankRef,
      opDate: parseDateEs(text(cells, 4), r),
      valueDate: text(cells, 5) !== "" ? parseDateEs(text(cells, 5), r) : null,
      concept,
      provider: normalizeBankProvider({
        provider: extractProvider(codeCommon ?? "", complementarios),
        concept,
        codeCommon,
        codeOwn,
        bank: "caixabank",
      }),
      amountCents: amount,
      balanceCents: balance,
      codeCommon,
      codeOwn,
      dedupRef: null,
      bankCategory: null,
      raw: buildRaw(headers, cells),
    });
  });
  if (rows.length === 0) {
    throw new FinanceParserError("no se encontró ninguna tabla de movimientos de CaixaBank", 0);
  }
  return rows;
}
