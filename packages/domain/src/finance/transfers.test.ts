import { describe, expect, it } from "vitest";

import {
  detectTransferPairs,
  type FinanceAccountView,
  type FinanceTxView,
} from "./index.js";

const acc = (id: string, aliases: string[] = []): FinanceAccountView => ({
  id, name: id, bank: "caixabank", kind: "comun", bankRef: `ref-${id}`,
  ownerAliases: aliases, transferRefs: [],
});
let n = 0;
function tx(overrides: Partial<FinanceTxView>): FinanceTxView {
  n += 1;
  return {
    id: `t${n}`, accountId: "a1", opDate: "2026-06-15", concept: "MOVIMIENTO",
    provider: null, providerNorm: null, amountCents: -1000n, categoryId: null,
    status: "pendiente", transferGroupId: null, recurrence: null,
    recurrenceManual: false, dedupHash: `h${n}`, codeCommon: null, codeOwn: null,
    categoryKind: null, ...overrides,
  };
}

describe("detectTransferPairs (port de transfers.py::detect_transfers)", () => {
  const accounts = [acc("a1", ["Padre Ejemplo"]), acc("a2")];

  it("cruza importes opuestos en cuentas distintas a ≤3 días; keyword+alias confirma", () => {
    const out = tx({ id: "out", accountId: "a1", amountCents: -30000n, concept: "TRASPASO A CUENTA AZUL Padre Ejemplo" });
    const back = tx({ id: "in", accountId: "a2", amountCents: 30000n, opDate: "2026-06-16", concept: "ABONO RECIBIDO" });
    const [p] = detectTransferPairs([out, back], accounts);
    expect(p).toEqual({ legIds: ["out", "in"], existingGroupId: null, status: "confirmada" });
  });

  it("sin keyword+alias la pareja queda como sugerida_regla", () => {
    const a = tx({ id: "x1", accountId: "a1", amountCents: -5000n });
    const b = tx({ id: "x2", accountId: "a2", amountCents: 5000n });
    expect(detectTransferPairs([a, b], accounts)[0]?.status).toBe("sugerida_regla");
  });

  it("no cruza misma cuenta, importes no opuestos ni más de 3 días", () => {
    const same = [tx({ accountId: "a1", amountCents: -100n }), tx({ accountId: "a1", amountCents: 100n })];
    const far = [
      tx({ accountId: "a1", amountCents: -100n, opDate: "2026-06-01" }),
      tx({ accountId: "a2", amountCents: 100n, opDate: "2026-06-05" }),
    ];
    expect(detectTransferPairs(same, accounts)).toHaveLength(0);
    expect(detectTransferPairs(far, accounts)).toHaveLength(0);
  });

  it("una pata huérfana reutiliza su grupo existente", () => {
    const lone = tx({ id: "lone", accountId: "a1", amountCents: -7000n, transferGroupId: "g-old", status: "confirmada" });
    const mate = tx({ id: "mate", accountId: "a2", amountCents: 7000n });
    const [p] = detectTransferPairs([lone, mate], accounts);
    expect(p?.existingGroupId).toBe("g-old");
  });

  it("recupera una confirmada como ingreso con keyword+alias (Aportaciones)", () => {
    const confirmed = tx({
      id: "conf", accountId: "a2", amountCents: 40000n, status: "confirmada",
      categoryId: "cat-ing", categoryKind: "ingreso",
      concept: "TRANSFERENCIA DE Padre Ejemplo APORTACION",
    });
    const charge = tx({ id: "chg", accountId: "a1", amountCents: -40000n });
    const pairs = detectTransferPairs([confirmed, charge], accounts);
    expect(pairs[0]?.legIds).toContain("conf");
  });

  it("una confirmada sin categoría de ingreso o sin keyword no se toca", () => {
    const confirmed = tx({ id: "c2", accountId: "a2", amountCents: 40000n, status: "confirmada", categoryKind: "gasto" });
    const charge = tx({ id: "c3", accountId: "a1", amountCents: -40000n });
    expect(detectTransferPairs([confirmed, charge], accounts)).toHaveLength(0);
  });
});

describe("detectTransferPairs: alias de titular en blanco", () => {
  // Mismo agujero que el de `transferRefs`: `ownerAliases` también es editable y
  // `concept.includes("")` es siempre true, así que un alias vacío confirmaría
  // cualquier pareja con keyword sin que el titular aparezca en el concepto.
  const conAliasEnBlanco = [acc("a1", ["", "  "]), acc("a2")];

  it("un alias en blanco no confirma la pareja por sí solo", () => {
    const out = tx({ id: "b1", accountId: "a1", amountCents: -9000n, concept: "TRASPASO A CUENTA AZUL" });
    const back = tx({ id: "b2", accountId: "a2", amountCents: 9000n, concept: "ABONO RECIBIDO" });
    expect(detectTransferPairs([out, back], conAliasEnBlanco)[0]?.status).toBe("sugerida_regla");
  });

  it("un alias en blanco no recupera una confirmada de ingreso", () => {
    const confirmed = tx({
      id: "b3", accountId: "a2", amountCents: 40000n, status: "confirmada",
      categoryId: "cat-ing", categoryKind: "ingreso", concept: "TRANSFERENCIA RECIBIDA",
    });
    const charge = tx({ id: "b4", accountId: "a1", amountCents: -40000n, status: "confirmada", categoryKind: "gasto" });
    expect(detectTransferPairs([confirmed, charge], conAliasEnBlanco)).toHaveLength(0);
  });
});
