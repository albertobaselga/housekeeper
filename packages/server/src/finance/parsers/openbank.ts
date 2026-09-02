import type { ParsedRow } from "@housekeeper/domain/finance";

import { FinanceParserError, balanceCentsOf, buildRaw, parseDateEs, toCents } from "./shared.js";

const DATE_RX = /^\d{2}\/\d{2}\/\d{4}$/;
const TRANSFER_RX = /^TRANSFERENCIA(?:\s+INMEDIATA)?\s+(?:A\s+FAVOR\s+DE|DE)\s+(.*)/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

/** Aplana el HTML de OpenBank a filas de celdas de texto (una lista por <tr>). */
function htmlTableRows(html: string): string[][] {
  const rows: string[][] = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    for (const td of (tr[1] as string).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)) {
      const inner = (td[1] as string).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "");
      cells.push(decodeEntities(inner).trim());
    }
    rows.push(cells);
  }
  return rows;
}

function obProvider(concept: string): string {
  const m = TRANSFER_RX.exec(concept);
  if (m !== null) {
    return ((m[1] as string).split(/,?\s*CONCEPTO\b/i)[0] as string).trim().slice(0, 200);
  }
  if (concept.toUpperCase().startsWith("LIQUIDACION")) return "Openbank";
  return concept.trim().slice(0, 200);
}

/** Port de parsers/openbank.py::parse (HTML disfrazado de .xls, iso-8859-1). */
export function parseOpenbank(bytes: Uint8Array): ParsedRow[] {
  const html = new TextDecoder("iso-8859-1").decode(bytes);
  const cellRows = htmlTableRows(html)
    .map((row) => row.filter((c) => c.trim() !== ""))
    .filter((row) => row.length > 0);

  let bankRef: string | null = null;
  for (const row of cellRows) {
    const head = (row[0] as string).trim().replace(/:+$/, "").toLowerCase();
    if (head.startsWith("número de cuenta") && row.length >= 2) {
      bankRef = (row[1] as string).replace(/ /g, "");
      break;
    }
  }
  if (bankRef === null) {
    throw new FinanceParserError("no se encontró el número de cuenta de OpenBank", 0);
  }
  const headers = cellRows.find((row) => row[0] === "Fecha Operación") ?? [];

  const rows: ParsedRow[] = [];
  cellRows.forEach((row, i) => {
    if (row.length < 5 || !DATE_RX.test(row[0] as string)) return;
    const [opRaw, valRaw, concept, importe, saldo] = row as [string, string, string, string, string];
    const amount = toCents(importe);
    if (amount === null) throw new FinanceParserError(`importe vacío en ${JSON.stringify(concept)}`, i);
    rows.push({
      accountRef: bankRef as string,
      bankRef: bankRef as string,
      opDate: parseDateEs(opRaw, i),
      valueDate: DATE_RX.test(valRaw) ? parseDateEs(valRaw, i) : null,
      concept,
      provider: obProvider(concept),
      amountCents: amount,
      balanceCents: balanceCentsOf(saldo, i), // vacío → null; ilegible → error
      codeCommon: null,
      codeOwn: null,
      dedupRef: null,
      bankCategory: null,
      raw: buildRaw(headers, row),
    });
  });
  if (rows.length === 0) throw new FinanceParserError("fichero de OpenBank sin movimientos", 0);
  return rows;
}
