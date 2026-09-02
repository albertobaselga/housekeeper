import { describe, expect, it } from "vitest";

import { matchRule, type FinanceRuleView, type FinanceTxView } from "./index.js";

function tx(overrides: Partial<FinanceTxView> = {}): FinanceTxView {
  return {
    id: "t1", accountId: "a1", opDate: "2026-06-05",
    concept: "RECIBO LUZ | CORE IBERDROLA CLIENTES", provider: "IBERDROLA CLIENTES",
    providerNorm: "IBERDROLA CLIENTES", amountCents: -5512n, categoryId: null,
    status: "pendiente", transferGroupId: null, recurrence: null,
    recurrenceManual: false, dedupHash: "h-t1", codeCommon: "03", codeOwn: "230",
    categoryKind: null, ...overrides,
  };
}
const rule = (o: Partial<FinanceRuleView>): FinanceRuleView => ({
  id: "r1", ruleType: "proveedor_exacto", pattern: "IBERDROLA CLIENTES",
  categoryId: "cat-casa", priority: 0, ...o,
});

describe("matchRule (port de rules_engine.py)", () => {
  it("proveedor_exacto compara formas normalizadas (tildes y espacios fuera)", () => {
    expect(matchRule(tx({ provider: "  Iberdrola   Clientes " }), [rule({})])).not.toBeNull();
    expect(matchRule(tx({ provider: null }), [rule({})])).toBeNull();
  });

  it("concepto_contiene busca la subcadena normalizada", () => {
    const r = rule({ id: "r2", ruleType: "concepto_contiene", pattern: "recibo luz" });
    expect(matchRule(tx(), [r])?.id).toBe("r2");
  });

  it("codigo_norma43 compara el código común exacto", () => {
    const r = rule({ id: "r3", ruleType: "codigo_norma43", pattern: "03" });
    expect(matchRule(tx(), [r])?.id).toBe("r3");
    expect(matchRule(tx({ codeCommon: "11" }), [r])).toBeNull();
  });

  it("mayor prioridad gana; a igual prioridad gana la más específica", () => {
    const generic = rule({ id: "gen", ruleType: "codigo_norma43", pattern: "03", priority: 0 });
    const specific = rule({ id: "spec", ruleType: "proveedor_exacto", priority: 0 });
    const priority = rule({ id: "prio", ruleType: "codigo_norma43", pattern: "03", priority: 5 });
    expect(matchRule(tx(), [generic, specific])?.id).toBe("spec");
    expect(matchRule(tx(), [generic, specific, priority])?.id).toBe("prio");
  });
});
