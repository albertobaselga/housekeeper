import { describe, expect, it } from "vitest";

import {
  matchEventRules,
  type FinanceCategoryView,
  type FinanceEventRuleView,
  type FinanceTxView,
} from "./index.js";

let n = 0;
function tx(overrides: Partial<FinanceTxView>): FinanceTxView {
  n += 1;
  return {
    id: `t${n}`, accountId: "a1", opDate: "2026-06-20", concept: "Cena viernes",
    provider: "MARIA GARCIA LOPEZ", providerNorm: null, amountCents: -1500n,
    categoryId: null, status: "confirmada", transferGroupId: null, recurrence: null,
    recurrenceManual: false, dedupHash: `h${n}`, codeCommon: null, codeOwn: null,
    categoryKind: null, ...overrides,
  };
}
const rule = (o: Partial<FinanceEventRuleView>): FinanceEventRuleView => ({
  id: "er1", providerNorm: "MARIA GARCIA LOPEZ", conceptNorm: null, categoryId: null,
  eventId: "ev1", ...o,
});
const categories: FinanceCategoryView[] = [
  { id: "viajes", parentId: null, name: "Viajes", kind: "gasto" },
  { id: "hoteles", parentId: "viajes", name: "Hoteles", kind: "gasto" },
  { id: "otros", parentId: null, name: "Otros", kind: "gasto" },
];
const base = { categories, aliases: [], existingAssignments: new Set<string>() };

describe("matchEventRules (port de event_rules.py)", () => {
  it("asigna por proveedor normalizado y respeta pares ya existentes", () => {
    const a = tx({ id: "a", provider: "  María García López " });
    expect(matchEventRules([a], [rule({})], base)).toEqual([{ txId: "a", eventId: "ev1" }]);
    expect(
      matchEventRules([a], [rule({})], { ...base, existingAssignments: new Set(["a:ev1"]) }),
    ).toHaveLength(0);
  });

  it("acepta el alias mostrado en lugar del proveedor crudo", () => {
    const a = tx({ id: "a2", provider: "PAYPAL *KOBO BOOKS" });
    const r = rule({ providerNorm: "KOBO BOOKS [PAYPAL]" });
    const aliases = [{ providerNorm: "PAYPAL *KOBO BOOKS", display: "Kobo Books [PayPal]" }];
    expect(matchEventRules([a], [r], { ...base, aliases })).toEqual([{ txId: "a2", eventId: "ev1" }]);
  });

  it("con conceptNorm compara el concepto colapsado y truncado a 80", () => {
    const largo = `Cena   ${"x".repeat(100)}`;
    const a = tx({ id: "a3", concept: largo });
    const conceptNorm = `CENA ${"X".repeat(75)}`; // normText(normalizeConcept(largo))
    expect(matchEventRules([a], [rule({ conceptNorm })], base)).toHaveLength(1);
    expect(matchEventRules([a], [rule({ conceptNorm: "OTRA COSA" })], base)).toHaveLength(0);
  });

  it("una regla de categoría arrastra las subcategorías directas y nunca transferencias", () => {
    const padre = tx({ id: "p", categoryId: "viajes" });
    const hija = tx({ id: "h", categoryId: "hoteles" });
    const ajena = tx({ id: "o", categoryId: "otros" });
    const transfer = tx({ id: "tr", categoryId: "viajes", transferGroupId: "g" });
    const r = rule({ providerNorm: null, categoryId: "viajes" }); // regla por categoría: provider_norm NULL en la tabla
    expect(matchEventRules([padre, hija, ajena, transfer], [r], base).map((p) => p.txId)).toEqual(["p", "h"]);
  });
});
