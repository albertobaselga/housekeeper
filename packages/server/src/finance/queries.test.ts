import { describe, expect, it } from "vitest";

import { monthsInRange, seriesWindow } from "./queries.js";

// El periodo anterior (prevRange) lo prueba la fase 2 en packages/domain: aquí
// no se replica ni se re-testea. Este fichero cubre solo lo propio de queries.ts.

describe("seriesWindow: N cubos hacia atrás desde el final del rango", () => {
  it("empieza el día 1 del mes (months-1) meses antes", () => {
    expect(seriesWindow("2026-08-31", 12)).toBe("2025-09-01");
    expect(seriesWindow("2026-02-15", 1)).toBe("2026-02-01");
  });

  it("no propaga NaN con una fecha malformada: cae a 1970-01-01 en vez de 'NaN-NaN-01'", () => {
    expect(seriesWindow("agosto", 1)).toBe("1970-01-01");
  });
});

describe("monthsInRange: los cubos de mes del pivot, calendario completo", () => {
  it("incluye el mes de inicio y el de fin aunque no haya movimientos", () => {
    expect(monthsInRange("2026-01-15", "2026-04-02")).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(monthsInRange("2026-03-01", "2026-03-31")).toEqual(["2026-03"]);
  });
  it("cruza el fin de año sin saltarse diciembre", () => {
    expect(monthsInRange("2025-11-20", "2026-02-01")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
  it("un rango invertido no devuelve nada", () => {
    expect(monthsInRange("2026-05-01", "2026-04-01")).toEqual([]);
  });

  // m10: sin tope, una URL manuscrita con from/to extremos (from=0001-01-01,
  // el suelo de finiteOr) fabricaría ~120.000 cadenas de mes para el pivot.
  it("un rango de siglos se acota a 600 meses (50 años), no fabrica decenas de miles", () => {
    const months = monthsInRange("0001-01-01", "9999-12-31");
    expect(months).toHaveLength(600);
    expect(months[0]).toBe("0001-01");
    expect(months[599]).toBe("0050-12");
  });
});
