import { describe, expect, it } from "vitest";

import {
  assessRecurrence,
  isRecurrentGroup,
  recurrenceFingerprint,
  type FinanceTxView,
} from "./index.js";

let n = 0;
function tx(overrides: Partial<FinanceTxView>): FinanceTxView {
  n += 1;
  return {
    id: `t${n}`, accountId: "a1", opDate: "2026-06-05", concept: "RECIBO LUZ",
    provider: "IBERDROLA CLIENTES 987654", providerNorm: null, amountCents: -5512n,
    categoryId: null, status: "confirmada", transferGroupId: null, recurrence: null,
    recurrenceManual: false, dedupHash: `h${n}`, codeCommon: "03", codeOwn: null,
    categoryKind: null, ...overrides,
  };
}

describe("recurrenceFingerprint (valores dorados del recurrence.py del origen)", () => {
  it("quita referencias y cae al tramo de 50 € si no quedan letras", () => {
    expect(recurrenceFingerprint("IBERDROLA CLIENTES 987654", "03", -5512n)).toBe("IBERDROLA CLIENTES");
    expect(recurrenceFingerprint("PRESTAMO 20276496", "05", -43512n)).toBe("PRESTAMO");
    expect(recurrenceFingerprint("2860 56 0001234", "04", -25000n)).toBe("04|5");
    expect(recurrenceFingerprint(null, null, -1500n)).toBe("??|0");
  });
});

describe("isRecurrentGroup (umbrales exactos del origen)", () => {
  const at = (opDate: string, cents: bigint, extra: Partial<FinanceTxView> = {}) =>
    tx({ opDate, amountCents: cents, codeCommon: null, concept: "PAGO", ...extra });
  it("≥3 meses distintos: recurrente sin más señales", () => {
    expect(isRecurrentGroup([at("2026-04-06", -100n), at("2026-05-05", -999n), at("2026-06-05", -5n)])).toBe(true);
  });
  it("2 meses: mediana estable ≤35 % o día ±4 (con vuelta de mes) o patrón recibo", () => {
    expect(isRecurrentGroup([at("2026-05-03", -5512n), at("2026-06-04", -5304n)])).toBe(true); // estable y día
    expect(isRecurrentGroup([at("2026-05-02", -1000n), at("2026-06-28", -9000n)])).toBe(false);
    expect(isRecurrentGroup([at("2026-05-30", -1000n), at("2026-06-02", -9000n)])).toBe(true); // wrap fin de mes
    expect(isRecurrentGroup([at("2026-05-02", -1000n), at("2026-06-20", -9000n, { concept: "CUOTA CLUB" })])).toBe(true);
    expect(isRecurrentGroup([at("2026-05-02", -1000n, { codeCommon: "05" }), at("2026-06-20", -9000n, { codeCommon: "05" })])).toBe(true);
  });
  it("1 mes: nunca recurrente", () => {
    expect(isRecurrentGroup([at("2026-06-01", -100n), at("2026-06-20", -100n)])).toBe(false);
  });
});

describe("assessRecurrence", () => {
  it("agrupa por huella+signo, respeta recurrence_manual y las patas de traspaso", () => {
    const a = tx({ id: "a", opDate: "2026-04-06" });
    const b = tx({ id: "b", opDate: "2026-05-05" });
    const c = tx({ id: "c", opDate: "2026-06-05", recurrenceManual: true });
    const d = tx({ id: "d", opDate: "2026-06-06", transferGroupId: "g1" });
    const solo = tx({ id: "solo", provider: "TIENDA UNICA", opDate: "2026-06-10" });
    const verdicts = assessRecurrence([a, b, c, d, solo]);
    expect(verdicts).toContainEqual({ txId: "a", recurrence: "recurrente" });
    expect(verdicts).toContainEqual({ txId: "b", recurrence: "recurrente" });
    expect(verdicts).toContainEqual({ txId: "solo", recurrence: "extraordinario" });
    expect(verdicts.map((v) => v.txId)).not.toContain("c");
    expect(verdicts.map((v) => v.txId)).not.toContain("d");
  });
  it("puede degradar recurrente→extraordinario y no repite veredictos ya escritos", () => {
    const stale = tx({ id: "s", recurrence: "recurrente", provider: "TIENDA X" });
    const done = tx({ id: "ok", recurrence: "extraordinario", provider: "TIENDA Y" });
    const verdicts = assessRecurrence([stale, done]);
    expect(verdicts).toContainEqual({ txId: "s", recurrence: "extraordinario" });
    expect(verdicts.map((v) => v.txId)).not.toContain("ok");
  });
});
