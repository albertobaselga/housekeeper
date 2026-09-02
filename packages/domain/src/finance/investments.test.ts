import { describe, expect, it } from "vitest";

import {
  detectInvestmentContributions,
  type FinanceAccountView,
  type FinanceTxView,
} from "./index.js";

// Las cuentas de inversión y la de efectivo NO tienen banco (CHECK de la fase 1):
// se reconocen por `kind` y por el `cashAccountId` que se pasa en `opts`.
const accounts: FinanceAccountView[] = [
  { id: "a1", name: "Caixa", bank: "caixabank", kind: "comun", bankRef: "r1", ownerAliases: [], transferRefs: [] },
  { id: "cash", name: "Efectivo", bank: null, kind: "comun", bankRef: "EFECTIVO", ownerAliases: [], transferRefs: [] },
  { id: "inv1", name: "Fondo Índice Global", bank: null, kind: "inversion", bankRef: "INV-1", ownerAliases: [], transferRefs: ["0001234"] },
  { id: "inv2", name: "Plan Pensiones", bank: null, kind: "inversion", bankRef: "INV-2", ownerAliases: [], transferRefs: ["COREINDEXA"] },
];
const opts = { cashAccountId: "cash" };
let n = 0;
function tx(overrides: Partial<FinanceTxView>): FinanceTxView {
  n += 1;
  return {
    id: `t${n}`, accountId: "a1", opDate: "2026-06-12", concept: "X", provider: null,
    providerNorm: null, amountCents: -25000n, categoryId: null, status: "pendiente",
    transferGroupId: null, recurrence: null, recurrenceManual: false,
    dedupHash: `h${n}`, codeCommon: "04", codeOwn: "073", categoryKind: null, ...overrides,
  };
}

describe("detectInvestmentContributions (port de investments.py)", () => {
  it("ref numérica de 7 dígitos casa contra «2860 56 <ref>» EN EL CONCEPTO", () => {
    const charge = tx({ id: "chg", concept: "TRANSFERENCIAS | 2860 56 0001234 APORTACION", provider: "BENEFICIARIO REESCRITO", dedupHash: "hash-chg" });
    const [p] = detectInvestmentContributions([charge], accounts, opts);
    expect(p).toMatchObject({
      chargeTxId: "chg",
      investmentAccountId: "inv1",
      mirrorAmountCents: 25000n,
      mirrorDedupHash: "invmirror-hash-chg",
      mirrorProvider: "Fondo Índice Global",
    });
    expect(p?.mirrorConcept).toContain("Fondo Índice Global");
  });

  it("ref textual casa por substring sobre provider+concept normalizados", () => {
    const charge = tx({ id: "c2", concept: "RECIBO COREINDEXA PENSIONES", provider: "INDEXA" });
    expect(detectInvestmentContributions([charge], accounts, opts)[0]?.investmentAccountId).toBe("inv2");
  });

  it("ref sin mapeo, cuenta excluida o espejo ya existente: nada", () => {
    const unmapped = tx({ id: "u1", concept: "TRANSFERENCIAS | 2860 56 9999999 X" });
    const amex = tx({ id: "u2", accountId: "amex1", concept: "2860 56 0001234" });
    const accountsConAmex = [...accounts, { id: "amex1", name: "Amex", bank: "amex" as const, kind: "personal" as const, bankRef: "rx", ownerAliases: [], transferRefs: [] }];
    const desdeEfectivo = tx({ id: "u5", accountId: "cash", concept: "2860 56 0001234" });
    const desdeInversion = tx({ id: "u6", accountId: "inv2", concept: "2860 56 0001234" });
    const mirrored = tx({ id: "u3", concept: "2860 56 0001234", dedupHash: "hh" });
    const mirror = tx({ id: "u4", accountId: "inv1", amountCents: 25000n, dedupHash: "invmirror-hh", transferGroupId: "g1" });
    expect(detectInvestmentContributions([unmapped], accounts, opts)).toHaveLength(0);
    expect(detectInvestmentContributions([amex], accountsConAmex, opts)).toHaveLength(0);
    // exclusiones por modelo de datos real: efectivo por id, inversión por kind
    expect(detectInvestmentContributions([desdeEfectivo], accounts, opts)).toHaveLength(0);
    expect(detectInvestmentContributions([desdeInversion], accounts, opts)).toHaveLength(0);
    expect(detectInvestmentContributions([mirrored, mirror], accounts, opts)).toHaveLength(0);
  });
});
