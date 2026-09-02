import { describe, expect, it } from "vitest";

import { FinanceParserError } from "./shared.js";
import { parseDeutsche } from "./deutschebank.js";
import { caixabankSampleXls, deutscheSampleXls, writeWorkbook } from "./synthetic-samples.js";

const IBAN = "ES4400190000000000000001";
const HEADER = ["", "date", "valuedate", "concept", "", "", "", "", "amount", "balance"];

/** Construye un libro mínimo de Deutsche Bank con una sola fila de datos, para
 * ejercer las rutas de error sin depender de `deutscheSampleXls()`. */
function deutscheMiniXls(iban: string, dataRow: string[] | null): Uint8Array {
  const grid: string[][] = [["", "Cuenta:", iban], [], HEADER];
  if (dataRow !== null) grid.push(dataRow);
  return writeWorkbook(grid, "biff8", "Hoja1");
}

describe("parseDeutsche (muestra sintética, sin skip)", () => {
  const rows = parseDeutsche(deutscheSampleXls());
  it("toma el IBAN de la cabecera y lee las tres filas", () => {
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.accountRef === IBAN)).toBe(true);
    // bankRef entra en el hash de dedup (types.ts): debe coincidir con accountRef, no basta con probar uno.
    expect(rows.every((r) => r.bankRef === IBAN)).toBe(true);
  });
  it("aplica los prefijos del origen al provider", () => {
    expect(rows.map((r) => r.provider)).toEqual([
      "IBERDROLA CLIENTES SAU", "JUAN EJEMPLO", "NOMINA EMPRESA EJEMPLO SL",
    ]);
    expect(rows[0]).toMatchObject({ opDate: "2026-05-05", amountCents: -5512n, balanceCents: 120000n });
    expect(rows[1]?.valueDate).toBeNull();
    expect(rows[2]?.amountCents).toBe(250000n);
  });
  it("construye raw con las claves de la cabecera", () => {
    expect(rows[0]?.raw).toMatchObject({
      date: "05/05/2026", amount: "-55,12", balance: "1.200,00",
      concept: "RECIBO  IBERDROLA CLIENTES SAU",
    });
  });
  it("sin IBAN ni cabecera lanza FinanceParserError", () => {
    expect(() => parseDeutsche(caixabankSampleXls())).toThrow(FinanceParserError);
  });
  it("un IBAN vacío en la fila «Cuenta:» se trata como ausente, no como accountRef vacío", () => {
    const bytes = deutscheMiniXls("", ["", "05/05/2026", "", "PAGO", "", "", "", "", "-10,00", "10,00"]);
    expect(() => parseDeutsche(bytes)).toThrow(/no se encontró el IBAN/);
  });
  it("importe vacío lanza FinanceParserError en vez de colar un amountCents nulo", () => {
    const bytes = deutscheMiniXls(IBAN, ["", "05/05/2026", "", "PAGO SIN IMPORTE", "", "", "", "", "", "10,00"]);
    expect(() => parseDeutsche(bytes)).toThrow(/importe vacío/);
  });
  it("saldo ilegible en la columna 9 lanza FinanceParserError en vez de quedarse en null", () => {
    const bytes = deutscheMiniXls(IBAN, [
      "", "05/05/2026", "", "PAGO SALDO RARO", "", "", "", "", "-10,00", "SALDO NO DISPONIBLE",
    ]);
    expect(() => parseDeutsche(bytes)).toThrow(/saldo ilegible/);
  });
  it("cabecera sin filas de datos lanza FinanceParserError de «sin movimientos»", () => {
    const bytes = deutscheMiniXls(IBAN, null);
    expect(() => parseDeutsche(bytes)).toThrow(/sin movimientos/);
  });
});
