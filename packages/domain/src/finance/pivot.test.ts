import { describe, expect, it } from "vitest";

import {
  buildPivotTree,
  collectNodeMovIds,
  parseDims,
  sortPivotTree,
  type PivotSourceRow,
} from "./index.js";

let m = 0;
function row(overrides: Partial<PivotSourceRow>): PivotSourceRow {
  m += 1;
  return {
    cat: "Casa", sub: null, catId: "c1", nat: null, prov: "PROV", concept: "CONCEPTO",
    event: null, eventId: null, kind: "gasto", month: "2026-06", totalCents: -1000n,
    count: 1, movs: [{ id: `mv${m}`, date: "2026-06-05", cents: -1000n }], ...overrides,
  };
}

describe("buildPivotTree (port de pivotTree.buildPivotSections)", () => {
  it("particiona por kind sin perder filas y calcula subtotales y TOTAL NETO", () => {
    const rows = [
      row({ kind: "gasto", totalCents: -2000n }),
      row({ kind: "ingreso", cat: "Nómina", totalCents: 300000n }),
      row({ kind: "transferencia", cat: "Traspaso X", totalCents: -5000n }),
      row({ kind: "inversion", cat: "Fondo", totalCents: 5000n }),
    ];
    const tree = buildPivotTree(rows, ["cat", "sub"], { monthsCount: 2 });
    expect(tree.gastos).toHaveLength(1);
    expect(tree.ingresos).toHaveLength(1);
    expect(tree.internas).toHaveLength(1);
    expect(tree.inversiones).toHaveLength(1);
    expect(tree.subtotales.totalNeto.totalCents).toBe(298000n); // sin internas ni inversiones
    expect(tree.subtotales.gastos.avgCents).toBe(-1000n); // -2000/2 meses
  });

  it("un evento cuelga de EVENTOS salvo que esté duplicado; TOTAL NETO cuenta una sola vez", () => {
    const rows = [
      row({ eventId: "ev1", event: "Semana Santa", totalCents: -4000n }),
      row({ totalCents: -1000n }),
    ];
    const sinDup = buildPivotTree(rows, ["cat"], { monthsCount: 1 });
    expect(sinDup.gastos[0]?.totalCents).toBe(-1000n);
    expect(sinDup.eventos[0]?.netCents).toBe(-4000n);
    expect(sinDup.subtotales.totalNeto.totalCents).toBe(-5000n);
    const conDup = buildPivotTree(rows, ["cat"], { monthsCount: 1, dupEventIds: new Set(["ev1"]) });
    expect(conDup.gastos[0]?.totalCents).toBe(-5000n); // el evento también bajo su categoría
    expect(conDup.subtotales.totalNeto.totalCents).toBe(-5000n); // pero solo una vez
  });

  it("nat ordena ♻ → ✦ → sin clasificar y movement es hoja terminal", () => {
    const rows = [
      row({ nat: null }),
      row({ nat: "extraordinario" }),
      row({ nat: "recurrente" }),
    ];
    const tree = buildPivotTree(rows, ["nat", "movement"], { monthsCount: 1 });
    expect(tree.gastos.map((n) => n.label)).toEqual(["♻ Recurrente", "✦ Extraordinario", "Sin clasificar"]);
    const leaf = tree.gastos[0]?.children[0];
    expect(leaf?.movs).toHaveLength(1);
    expect(leaf?.children).toHaveLength(0);
    expect(leaf?.label.startsWith("2026-06-05 · ")).toBe(true);
  });

  it("INTERNAS baja grupo→pata→concepto→movimiento ignorando las dims del usuario", () => {
    const rows = [row({ kind: "transferencia", cat: "Traspaso X", prov: "Cuenta Azul" })];
    const tree = buildPivotTree(rows, ["cat"], { monthsCount: 1 });
    const grupo = tree.internas[0];
    expect(grupo?.label).toBe("Traspaso X");
    expect(grupo?.children[0]?.label).toBe("Cuenta Azul");
    expect(grupo?.children[0]?.children[0]?.children[0]?.movs).toHaveLength(1);
  });

  it("sortPivotTree reordena gastos/ingresos/eventos por columna y collectNodeMovIds resuelve ids", () => {
    const rows = [
      row({ cat: "Aaa", totalCents: -1000n }),
      row({ cat: "Zzz", totalCents: -9000n }),
    ];
    const tree = buildPivotTree(rows, ["cat"], { monthsCount: 1 });
    const sorted = sortPivotTree(tree, "total", "asc");
    expect(sorted.gastos.map((n) => n.label)).toEqual(["Zzz", "Aaa"]);
    const ids = collectNodeMovIds(tree);
    expect(ids.get(tree.gastos[0]?.key ?? "")).toHaveLength(1);
  });

  it("la misma categoría en GASTOS y en un evento NO comparte clave", () => {
    const rows = [
      row({ cat: "Casa", totalCents: -1000n }),
      row({ cat: "Casa", eventId: "ev1", event: "Semana Santa", totalCents: -4000n }),
    ];
    const tree = buildPivotTree(rows, ["cat"], { monthsCount: 1 });
    const gastoKey = tree.gastos[0]?.key ?? "";
    const eventoKey = tree.eventos[0]?.children[0]?.key ?? "";
    expect(gastoKey).toBe("gastos/cat:Casa");
    expect(eventoKey).toBe("evento:ev1/cat:Casa");
    const ids = collectNodeMovIds(tree);
    expect(ids.get(gastoKey)).toHaveLength(1);
    expect(ids.get(eventoKey)).toHaveLength(1);
    expect(ids.get(gastoKey)).not.toEqual(ids.get(eventoKey));
  });
});

describe("parseDims", () => {
  it("filtra dims inválidas, deduplica y cae al default", () => {
    expect(parseDims("cat,sub")).toEqual(["cat", "sub"]);
    expect(parseDims("cat,cat,zz")).toEqual(["cat"]);
    expect(parseDims(null)).toEqual(["cat", "sub"]);
    expect(parseDims("zz")).toEqual(["cat", "sub"]);
  });
});
