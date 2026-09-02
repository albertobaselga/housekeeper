import * as XLSX from "xlsx";

/** Nombre EXACTO de la hoja que solo trae el export de Amex. Vive aquí (y no en
 * `index.ts`) para que `index.ts` y `amex.ts` no formen un ciclo de módulos y
 * para que el literal no se duplique en `synthetic-samples.ts`. */
export const AMEX_SHEET = "Detalles de la operación";

/** Literal de cabecera que marca el inicio de una tabla de movimientos de CaixaBank. */
export const CAIXABANK_HEADER_MARK = "Número de cuenta";

/** Literal de cabecera que precede al IBAN en un extracto de Deutsche Bank. */
export const DEUTSCHE_HEADER_MARK = "Cuenta:";

/** Error de parser con número de fila, como base.py::ParseError del origen. */
export class FinanceParserError extends Error {
  readonly row: number;
  constructor(msg: string, row: number) {
    super(`Fila ${row}: ${msg}`);
    this.name = "FinanceParserError";
    this.row = row;
  }
}

/** Port de money.py::to_cents: texto es-ES ("1.234,56") o número de celda → céntimos. */
export function toCents(value: unknown): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? BigInt(Math.round(value * 100)) : null;
  }
  const text = String(value).trim().replace(/\./g, "").replace(/,/g, ".");
  if (text === "") return null;
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (m === null) return null; // texto no numérico: lo decide el llamador
  const sign = m[1] === "-" ? -1n : 1n;
  const frac = (m[3] ?? "").padEnd(2, "0");
  let cents = BigInt(m[2] as string) * 100n + BigInt(frac.slice(0, 2) || "0");
  if (frac.length > 2 && Number(frac.charAt(2)) >= 5) cents += 1n; // no ocurre en extractos reales
  return sign * cents;
}

/** Saldo de una celda: VACÍA → null (el extracto no lo trae); con contenido
 * ILEGIBLE → error. Nunca null en silencio: el saldo entra en la cadena canónica
 * de dedup (serializado como "None" si falta), así que un saldo corrupto
 * convertido en null cambiaría el hash y rompería la verificación cruzada con
 * los datos migrados de la fase 3 sin aviso. */
export function balanceCentsOf(value: unknown, row: number): bigint | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const cents = toCents(value);
  if (cents === null) {
    throw new FinanceParserError(`saldo ilegible ${JSON.stringify(String(value).trim())}`, row);
  }
  return cents;
}

const DATE_ES_RX = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** dd/mm/yyyy → yyyy-mm-dd validando que la fecha exista (como strptime). */
export function parseDateEs(s: string, row: number): string {
  const m = DATE_ES_RX.exec(s.trim());
  if (m !== null) {
    const [, d, mo, y] = m as unknown as [string, string, string, string];
    const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    if (
      dt.getUTCFullYear() === Number(y) &&
      dt.getUTCMonth() + 1 === Number(mo) &&
      dt.getUTCDate() === Number(d)
    ) {
      return `${y}-${mo}-${d}`;
    }
  }
  throw new FinanceParserError(`fecha inválida ${JSON.stringify(s)}`, row);
}

/** Rejilla de una hoja del libro aplicando la receta SheetJS común a todos los
 * parsers (`header: 1, raw: true, defval: ""`): la hoja `name` si se indica, o
 * la primera si no. Lanza FinanceParserError si el libro no tiene hojas o si
 * se pide una hoja que no existe. */
export function sheetGrid(wb: XLSX.WorkBook, name?: string): unknown[][] {
  const sheetName = name ?? wb.SheetNames[0];
  if (sheetName === undefined) {
    throw new FinanceParserError("libro sin hojas", 0);
  }
  const sheet = wb.Sheets[sheetName];
  if (sheet === undefined) {
    throw new FinanceParserError(`no se encontró la hoja '${sheetName}'`, 0);
  }
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
}

/** Port de base.py::build_raw: dict cabecera→valor con claves únicas. */
export function buildRaw(
  headers: readonly unknown[],
  values: readonly unknown[],
): Record<string, string> {
  const raw: Record<string, string> = {};
  values.forEach((v, i) => {
    const h = i < headers.length ? String(headers[i] ?? "").trim() : "";
    const val = v === null || v === undefined ? "" : String(v).trim();
    if (h === "" && val === "") return;
    let key = h === "" ? `col${i}` : h;
    if (key in raw) key = `${key} ${i}`;
    raw[key] = val;
  });
  return raw;
}
