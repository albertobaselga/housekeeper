import { describe, expect, it } from "vitest";

import {
  DomainRuleError,
  addCalendarDays,
  isDateInClosedRange,
  isoWeekBounds,
  localDate,
} from "./index.js";

describe("fechas de calendario locales", () => {
  it("valida fechas reales del calendario", () => {
    expect(localDate("2026-02-28")).toBe("2026-02-28");
    expect(localDate("2024-02-29")).toBe("2024-02-29");
    expect(() => localDate("2025-02-30")).toThrow(DomainRuleError);
    expect(() => localDate("2025-13-01")).toThrow(DomainRuleError);
    expect(() => localDate("2025-1-01")).toThrow(DomainRuleError);
  });

  it("suma días cruzando mes, año y años bisiestos", () => {
    expect(addCalendarDays(localDate("2026-01-31"), 1)).toBe("2026-02-01");
    expect(addCalendarDays(localDate("2025-12-31"), 1)).toBe("2026-01-01");
    expect(addCalendarDays(localDate("2024-02-28"), 1)).toBe("2024-02-29");
    expect(addCalendarDays(localDate("2025-03-01"), -1)).toBe("2025-02-28");
  });

  it("evalúa rangos cerrados con ambos extremos incluidos", () => {
    const from = localDate("2026-03-01");
    const through = localDate("2026-03-31");
    expect(isDateInClosedRange(localDate("2026-03-01"), from, through)).toBe(true);
    expect(isDateInClosedRange(localDate("2026-03-31"), from, through)).toBe(true);
    expect(isDateInClosedRange(localDate("2026-02-28"), from, through)).toBe(false);
    expect(isDateInClosedRange(localDate("2026-04-01"), from, through)).toBe(false);
  });
});

describe("límites de semana ISO (parte semanal lunes–domingo)", () => {
  it("un lunes es el inicio de su propia semana", () => {
    // 2026-03-09 es lunes.
    expect(isoWeekBounds(localDate("2026-03-09"))).toEqual({
      monday: "2026-03-09",
      sunday: "2026-03-15",
    });
  });

  it("un domingo cierra la semana que empezó seis días antes", () => {
    // 2026-03-01 es domingo: su semana empieza el lunes 23 de febrero.
    expect(isoWeekBounds(localDate("2026-03-01"))).toEqual({
      monday: "2026-02-23",
      sunday: "2026-03-01",
    });
  });

  it("una semana puede cruzar el límite de año", () => {
    // 2025-12-31 es miércoles: la semana va del 29/12/2025 al 04/01/2026.
    expect(isoWeekBounds(localDate("2025-12-31"))).toEqual({
      monday: "2025-12-29",
      sunday: "2026-01-04",
    });
  });
});
