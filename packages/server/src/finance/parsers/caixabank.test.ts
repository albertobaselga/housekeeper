import { describe, expect, it } from "vitest";

import { FinanceParserError } from "./shared.js";
import { parseCaixabank } from "./caixabank.js";
import { caixabankSampleXls, deutscheSampleXls, writeWorkbook } from "./synthetic-samples.js";

/** Cabecera mínima de CaixaBank para libros construidos ad-hoc en este fichero
 * (solo lo que `parseCaixabank` inspecciona: col 1 debe ser exactamente
 * «Número de cuenta»; el resto de nombres son ilustrativos, no se aserta `raw` aquí). */
const HEADER_ROW = [
  "",
  "Número de cuenta",
  "Oficina",
  "Referencia",
  "Fecha operación",
  "Fecha valor",
  "Ingreso (+)",
  "Gasto (-)",
  "Saldo (+)",
  "Saldo (-)",
  "Código común",
  "Código propio",
  "Concepto común",
  "Concepto propio",
];

describe("parseCaixabank (muestra sintética, sin skip)", () => {
  const rows = parseCaixabank(caixabankSampleXls());

  it("lee las dos tablas y sus dos cuentas", () => {
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.accountRef))).toEqual(
      new Set(["21000000000000001234", "21000000000000005678"]),
    );
    expect(rows[0]?.bankRef).toBe(rows[0]?.accountRef);
  });

  it("tarjeta: importe negativo, saldo, códigos, provider del comercio", () => {
    const r = rows[0]!;
    expect(r.opDate).toBe("2026-05-04");
    expect(r.valueDate).toBe("2026-05-05");
    expect(r.amountCents).toBe(-4230n);
    expect(r.balanceCents).toBe(102345n);
    expect(r.codeCommon).toBe("11");
    expect(r.codeOwn).toBe("612");
    expect(r.provider).toBe("Peluquería Ñoño");
    expect(r.concept).toBe(
      "COMPRA TARJETA | 5402XXXX1111 | Fecha de operación: 02-05-2026 Peluquería Ñoño | 04000174TCR",
    );
    expect(r.raw["Número de cuenta"]).toBe("2100 0000 0000 0000 1234");
  });

  it("recibo SEPA sin saldo ni fecha valor; bizum con persona como provider", () => {
    expect(rows[1]).toMatchObject({ amountCents: -5512n, balanceCents: null, valueDate: null, provider: "IBERDROLA CLIENTES" });
    expect(rows[2]).toMatchObject({ amountCents: 2500n, provider: "MARIA GARCIA LOPEZ" });
  });

  it("un fichero sin tabla CaixaBank lanza FinanceParserError", () => {
    expect(() => parseCaixabank(deutscheSampleXls())).toThrow(FinanceParserError);
  });
});

describe("parseCaixabank (rama Saldo (−) y errores propios sin ejercitar en la muestra)", () => {
  it("Saldo (−) con Saldo (+) vacío invierte el signo", () => {
    const grid: string[][] = [
      HEADER_ROW,
      ["", "2100 0000 0000 0000 9999", "", "", "04/05/2026", "", "", "10,00", "", "37,50"],
    ];
    const [row] = parseCaixabank(writeWorkbook(grid, "biff8", "Movimientos"));
    expect(row).toMatchObject({ balanceCents: -3750n });
  });

  it("CCC no numérico (tras quitar espacios) lanza FinanceParserError", () => {
    const grid: string[][] = [
      HEADER_ROW,
      ["", "2100 ABC", "", "", "04/05/2026", "", "10,00", "", "100,00", ""],
    ];
    expect(() => parseCaixabank(writeWorkbook(grid, "biff8", "Movimientos"))).toThrow(
      FinanceParserError,
    );
  });

  it("sin importe de ingreso ni de gasto lanza FinanceParserError", () => {
    const grid: string[][] = [
      HEADER_ROW,
      ["", "2100 0000 0000 0000 9999", "", "", "04/05/2026", "", "", "", "100,00", ""],
    ];
    expect(() => parseCaixabank(writeWorkbook(grid, "biff8", "Movimientos"))).toThrow(
      FinanceParserError,
    );
  });
});
