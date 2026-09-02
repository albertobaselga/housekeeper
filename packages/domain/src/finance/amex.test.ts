import { describe, expect, it } from "vitest";

import { reconcileAmex, type FinanceAccountView, type FinanceTxView } from "./index.js";

const accounts: FinanceAccountView[] = [
  { id: "amex1", name: "Amex Oro", bank: "amex", kind: "personal", bankRef: "XXXX-XXXXX-91009", ownerAliases: [], transferRefs: [] },
  { id: "a1", name: "Caixa", bank: "caixabank", kind: "comun", bankRef: "21000000000000001234", ownerAliases: [], transferRefs: [] },
];
let n = 0;
function tx(overrides: Partial<FinanceTxView>): FinanceTxView {
  n += 1;
  return {
    id: `t${n}`, accountId: "a1", opDate: "2026-06-10", concept: "X", provider: null,
    providerNorm: null, amountCents: -1000n, categoryId: null, status: "pendiente",
    transferGroupId: null, recurrence: null, recurrenceManual: false,
    dedupHash: `h${n}`, codeCommon: null, codeOwn: null, categoryKind: null, ...overrides,
  };
}
const payment = (id: string, cents: bigint, opDate: string) =>
  tx({ id, accountId: "amex1", amountCents: cents, opDate, concept: "Recibo enviado a su banco" });
const charge = (id: string, cents: bigint, opDate: string) =>
  tx({ id, amountCents: cents, opDate, provider: "AMERICAN EXPRESS EUROPE", concept: "ADEUDO SEPA" });

describe("reconcileAmex (port de amex.py::reconcile_amex_payments)", () => {
  it("empareja recibo (+) con cargo (−) exacto a ≤10 días como confirmada", () => {
    const [p] = reconcileAmex([payment("pay", 50000n, "2026-06-10"), charge("chg", -50000n, "2026-06-14")], accounts);
    expect(p).toEqual({ legIds: ["pay", "chg"], existingGroupId: null, status: "confirmada" });
  });

  it("elige el cargo más cercano en fecha y no reutiliza cargos", () => {
    const pairs = reconcileAmex(
      [
        payment("pay", 50000n, "2026-06-10"),
        charge("far", -50000n, "2026-06-19"),
        charge("near", -50000n, "2026-06-11"),
      ],
      accounts,
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.legIds).toEqual(["pay", "near"]);
  });

  it("fuera de ventana, importe distinto o sin marcador: nada", () => {
    expect(reconcileAmex([payment("p1", 50000n, "2026-06-01"), charge("c1", -50000n, "2026-06-13")], accounts)).toHaveLength(0);
    expect(reconcileAmex([payment("p2", 50000n, "2026-06-10"), charge("c2", -49999n, "2026-06-11")], accounts)).toHaveLength(0);
    const noMarker = tx({ id: "c3", amountCents: -50000n, provider: "OTRO", concept: "ADEUDO" });
    expect(reconcileAmex([payment("p3", 50000n, "2026-06-10"), noMarker], accounts)).toHaveLength(0);
  });

  it("sin cuenta Amex no hay nada que conciliar", () => {
    const soloCaixa = accounts.filter((a) => a.bank !== "amex");
    expect(reconcileAmex([payment("p4", 50000n, "2026-06-10"), charge("c4", -50000n, "2026-06-11")], soloCaixa)).toHaveLength(0);
  });
});
