import { describe, expect, it } from "vitest";

import { seriesWindow } from "./queries.js";

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
