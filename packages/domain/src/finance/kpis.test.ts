import { describe, expect, it } from "vitest";

import {
  computeRangeSummary,
  prevRange,
  type FinanceAccountView,
  type FinanceTxView,
  type SummaryOptions,
} from "./index.js";

const accounts: FinanceAccountView[] = [
  { id: "a1", name: "Común", bank: "caixabank", kind: "comun", bankRef: "r1", ownerAliases: [], transferRefs: [] },
  { id: "a2", name: "Personal", bank: "openbank", kind: "personal", bankRef: "r2", ownerAliases: [], transferRefs: [] },
  { id: "inv1", name: "Fondo", bank: null, kind: "inversion", bankRef: "r3", ownerAliases: [], transferRefs: [] },
];
let n = 0;
function tx(overrides: Partial<FinanceTxView>): FinanceTxView {
  n += 1;
  return {
    id: `t${n}`, accountId: "a1", opDate: "2026-06-10", concept: "X", provider: null,
    providerNorm: null, amountCents: -1000n, categoryId: "c", status: "confirmada",
    transferGroupId: null, recurrence: null, recurrenceManual: false,
    dedupHash: `h${n}`, codeCommon: null, codeOwn: null, categoryKind: "gasto", ...overrides,
  };
}
const opts = (o: Partial<SummaryOptions> = {}): SummaryOptions => ({
  from: "2026-06-01", to: "2026-06-30", accounts, ...o,
});

describe("prevRange (port de reports._prev_range)", () => {
  it("bloques de meses de calendario retroceden bloques iguales alineados", () => {
    expect(prevRange("2026-04-01", "2026-06-30")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(prevRange("2026-01-01", "2026-01-31")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
  it("rangos arbitrarios retroceden por número de días", () => {
    expect(prevRange("2026-05-10", "2026-05-19")).toEqual({ from: "2026-04-30", to: "2026-05-09" });
  });
});

describe("computeRangeSummary (port de reports.range_summary)", () => {
  const txs: FinanceTxView[] = [
    tx({ amountCents: 300000n, categoryKind: "ingreso" }),
    tx({ amountCents: -80000n, recurrence: "recurrente" }),
    tx({ amountCents: -30000n, recurrence: "extraordinario" }),
    tx({ amountCents: -10000n }),
    // aportación a inversión: cargo (transferencia) + espejo en cuenta inversión
    tx({ id: "chg", amountCents: -50000n, categoryKind: "transferencia", transferGroupId: "g1" }),
    tx({ id: "mir", accountId: "inv1", amountCents: 50000n, categoryKind: "transferencia", transferGroupId: "g1" }),
    // periodo anterior (mayo)
    tx({ opDate: "2026-05-10", amountCents: 200000n, categoryKind: "ingreso" }),
    tx({ opDate: "2026-05-12", amountCents: -50000n }),
    // pendiente global fuera de rango
    tx({ opDate: "2026-01-05", status: "pendiente", categoryId: null, categoryKind: null }),
  ];

  it("calcula totales, desglose, tasas, inversión y flujos de caja", () => {
    const s = computeRangeSummary(txs, opts());
    expect(s.incomeCents).toBe(300000n);
    expect(s.expenseCents).toBe(-120000n);
    expect(s.recurringExpenseCents).toBe(-80000n);
    expect(s.extraordinaryExpenseCents).toBe(-30000n);
    expect(s.unclassifiedExpenseCents).toBe(-10000n);
    expect(s.savingsCents).toBe(180000n);
    expect(s.netSavingsRate).toBe(60);
    expect(s.grossSavingsRate).toBe(73.3);
    expect(s.investedCents).toBe(50000n);
    expect(s.investmentRate).toBe(16.7);
    expect(s.freeCashFlowCents).toBe(130000n);
    expect(s.opsCashFlowCents).toBe(180000n);
    expect(s.pendingCount).toBe(1);
    expect(s.prev?.savingsCents).toBe(150000n);
    expect(s.prev?.prev).toBeNull();
  });

  it("con filtro de cuentas: las aportaciones que cruzan cuentan como ingreso y los traspasos salientes no son gasto", () => {
    const cruce: FinanceTxView[] = [
      tx({ id: "sal", accountId: "a1", amountCents: -20000n, categoryKind: "transferencia", transferGroupId: "g2" }),
      tx({ id: "ent", accountId: "a2", amountCents: 20000n, categoryKind: "transferencia", transferGroupId: "g2" }),
      tx({ id: "gasto2", accountId: "a2", amountCents: -5000n }),
    ];
    const s = computeRangeSummary(cruce, opts({ accountIds: ["a2"] }));
    expect(s.receivedContributionsCents).toBe(20000n);
    expect(s.incomeCents).toBe(20000n);
    expect(s.expenseCents).toBe(-5000n);
    const vistoDesdeA1 = computeRangeSummary(cruce, opts({ accountIds: ["a1"] }));
    expect(vistoDesdeA1.outgoingTransfersCents).toBe(-20000n);
    expect(vistoDesdeA1.expenseCents).toBe(0n);
    const sinFiltro = computeRangeSummary(cruce, opts());
    expect(sinFiltro.receivedContributionsCents).toBe(0n); // grupo 100% interno
  });

  it("la inversión filtrada por cuentas sigue a la cuenta que aporta el cargo", () => {
    const s = computeRangeSummary(txs, opts({ accountIds: ["a1"] }));
    expect(s.investedCents).toBe(50000n);
    const otra = computeRangeSummary(txs, opts({ accountIds: ["a2"] }));
    expect(otra.investedCents).toBe(0n);
  });

  it("ingresos cero: tasas null", () => {
    const s = computeRangeSummary([tx({ amountCents: -1000n })], opts());
    expect(s.netSavingsRate).toBeNull();
    expect(s.grossSavingsRate).toBeNull();
    expect(s.investmentRate).toBeNull();
  });
});
