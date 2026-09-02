import { describe, expect, it } from "vitest";

import {
  cashCounterlegFor,
  detectCashMovements,
  type FinanceAccountView,
  type FinanceTxView,
} from "./index.js";

// La cuenta Efectivo no tiene banco (CHECK de la fase 1): se identifica por id.
const accounts: FinanceAccountView[] = [
  { id: "a1", name: "Caixa", bank: "caixabank", kind: "comun", bankRef: "r1", ownerAliases: [], transferRefs: [] },
  { id: "cash", name: "Efectivo", bank: null, kind: "comun", bankRef: "EFECTIVO", ownerAliases: [], transferRefs: [] },
];
const detectOpts = { cashAccountId: "cash" };
let n = 0;
function tx(overrides: Partial<FinanceTxView>): FinanceTxView {
  n += 1;
  return {
    id: `t${n}`, accountId: "a1", opDate: "2026-06-18", concept: "X", provider: null,
    providerNorm: null, amountCents: -6000n, categoryId: null, status: "pendiente",
    transferGroupId: null, recurrence: null, recurrenceManual: false,
    dedupHash: `h${n}`, codeCommon: null, codeOwn: null, categoryKind: null, ...overrides,
  };
}

describe("detectCashMovements (port de cash.py::detect_cash_withdrawals)", () => {
  it("reconoce las variantes de retirada del regex del origen", () => {
    for (const concept of ["REINT. CAJERO 1234", "CAJERO AUTOMATICO", "RETIRADA DE EFECTIVO", "RETIRADA EFECTIVO", "USO ATM"]) {
      expect(detectCashMovements([tx({ concept })], accounts, detectOpts)).toHaveLength(1);
    }
  });
  it("ignora abonos, confirmadas, agrupadas y la propia cuenta Efectivo", () => {
    expect(detectCashMovements([tx({ concept: "REINT. CAJERO", amountCents: 6000n })], accounts, detectOpts)).toHaveLength(0);
    expect(detectCashMovements([tx({ concept: "REINT. CAJERO", status: "confirmada" })], accounts, detectOpts)).toHaveLength(0);
    expect(detectCashMovements([tx({ concept: "REINT. CAJERO", transferGroupId: "g" })], accounts, detectOpts)).toHaveLength(0);
    expect(detectCashMovements([tx({ concept: "REINT. CAJERO", accountId: "cash" })], accounts, detectOpts)).toHaveLength(0);
  });
  it("sin cuenta Efectivo declarada no excluye ninguna cuenta", () => {
    expect(
      detectCashMovements([tx({ concept: "REINT. CAJERO", accountId: "cash" })], accounts, { cashAccountId: null }),
    ).toHaveLength(1);
  });
});

describe("cashCounterlegFor (port de cash.py::create_cash_counterleg)", () => {
  const opts = { cashAccountId: "cash", efectivoCategoryId: "cat-ef" };
  it("crea la contrapartida +Efectivo confirmada y manual con hash cashpair-", () => {
    const gasto = tx({ accountId: "cash", amountCents: -1500n, categoryId: "cat-ocio", categoryKind: "gasto", concept: "Cañas", dedupHash: "hg" });
    expect(cashCounterlegFor(gasto, opts)).toEqual({
      accountId: "cash", opDate: "2026-06-18", concept: "Contrapartida efectivo — Cañas",
      provider: "EFECTIVO", amountCents: 1500n, categoryId: "cat-ef",
      status: "confirmada", recurrenceManual: true, dedupHash: "cashpair-hg",
    });
  });
  it("no aplica fuera de Efectivo, a abonos, sin categoría, a la propia Efectivo o a no-gasto", () => {
    expect(cashCounterlegFor(tx({ categoryId: "c", categoryKind: "gasto" }), opts)).toBeNull();
    expect(cashCounterlegFor(tx({ accountId: "cash", amountCents: 100n, categoryId: "c", categoryKind: "gasto" }), opts)).toBeNull();
    expect(cashCounterlegFor(tx({ accountId: "cash", categoryId: null }), opts)).toBeNull();
    expect(cashCounterlegFor(tx({ accountId: "cash", categoryId: "cat-ef", categoryKind: "gasto" }), opts)).toBeNull();
    expect(cashCounterlegFor(tx({ accountId: "cash", categoryId: "c", categoryKind: "ingreso" }), opts)).toBeNull();
  });
});
