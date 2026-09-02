import { describe, expect, it } from "vitest";

import { FinanceParserError } from "./shared.js";
import { parseDeutsche } from "./deutschebank.js";
import { caixabankSampleXls, deutscheSampleXls } from "./synthetic-samples.js";

describe("parseDeutsche (muestra sintética, sin skip)", () => {
  const rows = parseDeutsche(deutscheSampleXls());
  it("toma el IBAN de la cabecera y lee las tres filas", () => {
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.accountRef === "ES4400190000000000000001")).toBe(true);
  });
  it("aplica los prefijos del origen al provider", () => {
    expect(rows.map((r) => r.provider)).toEqual([
      "IBERDROLA CLIENTES SAU", "JUAN EJEMPLO", "NOMINA EMPRESA EJEMPLO SL",
    ]);
    expect(rows[0]).toMatchObject({ opDate: "2026-05-05", amountCents: -5512n, balanceCents: 120000n });
    expect(rows[1]?.valueDate).toBeNull();
    expect(rows[2]?.amountCents).toBe(250000n);
  });
  it("sin IBAN ni cabecera lanza FinanceParserError", () => {
    expect(() => parseDeutsche(caixabankSampleXls())).toThrow(FinanceParserError);
  });
});
