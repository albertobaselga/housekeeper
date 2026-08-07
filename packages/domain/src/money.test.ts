import { describe, expect, it } from "vitest";

import {
  DomainRuleError,
  divideRoundHalfAwayFromZero,
  euroCentsToDecimal,
  formatEuroCents,
  moneyCents,
  parseEuroCents,
  prorateMoney,
  sumMoney,
} from "./index.js";

describe("dinero exacto en céntimos bigint", () => {
  it("interpreta decimales con coma o punto y siempre produce bigint", () => {
    expect(parseEuroCents("1453,30")).toBe(145330n);
    expect(parseEuroCents("1453.30")).toBe(145330n);
    expect(parseEuroCents("1400")).toBe(140000n);
    expect(parseEuroCents("47,3")).toBe(4730n);
    expect(parseEuroCents("-0,05")).toBe(-5n);
    expect(typeof parseEuroCents("0,01")).toBe("bigint");
  });

  it("rechaza importes agrupados o con más de dos decimales", () => {
    expect(() => parseEuroCents("1.453,30")).toThrow(DomainRuleError);
    expect(() => parseEuroCents("12,345")).toThrow(DomainRuleError);
    expect(() => parseEuroCents("1e3")).toThrow(DomainRuleError);
    expect(() => parseEuroCents("")).toThrow(DomainRuleError);
  });

  it("mantiene la identidad parse ∘ toDecimal sobre un muestreo de valores", () => {
    for (const cents of [0n, 1n, -1n, 99n, 100n, -12345n, 145330n, 999999999n]) {
      const value = moneyCents(cents);
      expect(parseEuroCents(euroCentsToDecimal(value))).toBe(value);
    }
  });

  it("formatea es-ES de forma determinista sin pasar por Number", () => {
    expect(formatEuroCents(moneyCents(145330n))).toBe("1.453,30 €");
    expect(formatEuroCents(moneyCents(-10000n))).toBe("−100,00 €");
    expect(formatEuroCents(moneyCents(5n))).toBe("0,05 €");
    expect(formatEuroCents(moneyCents(123456789n))).toBe("1.234.567,89 €");
  });

  it("suma importes sin pérdida", () => {
    expect(sumMoney([moneyCents(1n), moneyCents(-3n), moneyCents(145330n)])).toBe(145328n);
    expect(sumMoney([])).toBe(0n);
  });

  it("redondea mitades alejándose de cero en ambos signos", () => {
    expect(divideRoundHalfAwayFromZero(5n, 2n)).toBe(3n);
    expect(divideRoundHalfAwayFromZero(-5n, 2n)).toBe(-3n);
    expect(divideRoundHalfAwayFromZero(3n, 2n)).toBe(2n);
    expect(divideRoundHalfAwayFromZero(1n, 3n)).toBe(0n);
    expect(divideRoundHalfAwayFromZero(-7n, 2n)).toBe(-4n);
    expect(() => divideRoundHalfAwayFromZero(1n, 0n)).toThrow(DomainRuleError);
  });

  it("prorratea tarifas por minutos sin perder céntimos", () => {
    // 90 minutos a 12,00 €/h → 18,00 €.
    expect(prorateMoney(moneyCents(1200n), 90n, 60n)).toBe(1800n);
    // 25 minutos a 12,00 €/h → 500 céntimos exactos.
    expect(prorateMoney(moneyCents(1200n), 25n, 60n)).toBe(500n);
    // 1 minuto a 0,01 €/h redondea la mitad hacia arriba: 0,0166… → 0 céntimos.
    expect(prorateMoney(moneyCents(1n), 1n, 60n)).toBe(0n);
    expect(prorateMoney(moneyCents(1n), 30n, 60n)).toBe(1n);
  });
});
