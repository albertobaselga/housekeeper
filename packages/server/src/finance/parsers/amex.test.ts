import { describe, expect, it } from "vitest";

import { FinanceParserError } from "./shared.js";
import { parseAmex } from "./amex.js";
import { amexSampleXlsx, amexSampleXlsxSinHoja } from "./synthetic-samples.js";

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
