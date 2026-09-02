import { describe, expect, it } from "vitest";

import { FinanceParserError } from "./shared.js";
import { parseAmex } from "./amex.js";
import {
  amexSampleXlsx,
  amexSampleXlsxSinCabecera,
  amexSampleXlsxSinHoja,
  amexSampleXlsxSinImporte,
  amexSampleXlsxSinReferencia,
} from "./synthetic-samples.js";

describe("parseAmex (muestra sintética, sin skip)", () => {
  const rows = parseAmex(amexSampleXlsx());
  it("invierte el signo y arrastra referencia y categoría del banco", () => {
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      accountRef: "XXXX-XXXXX-91009", opDate: "2026-05-06", amountCents: -1899n,
      dedupRef: "320261250012345678", bankCategory: "Compras", provider: "AMAZON ES",
      valueDate: null, balanceCents: null,
    });
    expect(rows[1]).toMatchObject({ amountCents: 50000n, bankCategory: null });
  });
  it("sin la hoja de detalles lanza FinanceParserError", () => {
    expect(() => parseAmex(amexSampleXlsxSinHoja())).toThrow(FinanceParserError);
  });
});

// Las tres ramas de error propias del fichero de Amex: son las que protegen la
// referencia de dedup de la tarjeta, que es lo único que la identifica.
describe("parseAmex: las tres ramas de error del fichero", () => {
  it("con la hoja pero sin número de cuenta ni cabecera", () => {
    expect(() => parseAmex(amexSampleXlsxSinCabecera())).toThrow(FinanceParserError);
    expect(() => parseAmex(amexSampleXlsxSinCabecera())).toThrow(
      "Fila 0: no se encontró el número de cuenta o la cabecera de la tabla",
    );
  });

  it("una fila con fecha pero sin importe", () => {
    expect(() => parseAmex(amexSampleXlsxSinImporte())).toThrow(FinanceParserError);
    expect(() => parseAmex(amexSampleXlsxSinImporte())).toThrow(
      'Fila 5: importe vacío en "AMAZON ES"',
    );
  });

  it("una fila sin referencia: antes abortar que inventarse el dedup", () => {
    expect(() => parseAmex(amexSampleXlsxSinReferencia())).toThrow(FinanceParserError);
    expect(() => parseAmex(amexSampleXlsxSinReferencia())).toThrow(
      'Fila 5: referencia vacía en "AMAZON ES"',
    );
  });
});
