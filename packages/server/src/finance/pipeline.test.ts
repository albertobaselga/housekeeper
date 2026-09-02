import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

import type {
  FinanceAccountView,
  FinanceBank,
  FinanceCategoryView,
  FinanceTxView,
} from "@housekeeper/domain/finance";

import {
  PIPELINE_ORDER,
  runPipelineSteps,
  runPostImportPipeline,
  type PipelineState,
} from "./pipeline.js";

// `bank` es NULL en las cuentas sin banco (Efectivo, inversión): el CHECK de la
// fase 1 solo admite los cuatro bancos reales.
const acc = (id: string, bank: FinanceBank | null, kind: FinanceAccountView["kind"], extra: Partial<FinanceAccountView> = {}): FinanceAccountView =>
  ({ id, name: id, bank, kind, bankRef: `ref-${id}`, ownerAliases: [], transferRefs: [], ...extra });
function tx(id: string, overrides: Partial<FinanceTxView>): FinanceTxView {
  return {
    id, accountId: "a1", opDate: "2026-06-10", concept: "X", provider: null,
    providerNorm: null, amountCents: -1000n, categoryId: null, status: "pendiente",
    transferGroupId: null, recurrence: null, recurrenceManual: false,
    dedupHash: `h-${id}`, codeCommon: null, codeOwn: null, categoryKind: null, ...overrides,
  };
}
const categories: FinanceCategoryView[] = [
  { id: "cat-tr", parentId: null, name: "Transferencias internas", kind: "transferencia" },
  { id: "cat-casa", parentId: null, name: "Casa", kind: "gasto" },
];

function buildState(): PipelineState {
  return {
    accounts: [
      acc("a1", "caixabank", "comun", { ownerAliases: ["Padre Ejemplo"] }),
      acc("a2", "openbank", "personal"),
      acc("amex1", "amex", "personal"),
      acc("inv1", null, "inversion", { transferRefs: ["0001234"] }),
      { id: "cash", name: "Efectivo", bank: null, kind: "comun", bankRef: "EFECTIVO", ownerAliases: [], transferRefs: [] },
    ],
    categories: [...categories],
    rules: [{ id: "r1", ruleType: "proveedor_exacto", pattern: "IBERDROLA CLIENTES", categoryId: "cat-casa", priority: 0 }],
    eventRules: [{ id: "er1", providerNorm: "MARIA GARCIA LOPEZ", conceptNorm: null, categoryId: null, eventId: "ev1" }],
    aliases: [],
    txEvents: [],
    txs: [
      tx("iber1", { provider: "IBERDROLA CLIENTES", codeCommon: "03", concept: "RECIBO LUZ", amountCents: -5512n }),
      tx("iber2", { provider: "IBERDROLA CLIENTES", codeCommon: "03", concept: "RECIBO LUZ", amountCents: -5498n, opDate: "2026-05-05", status: "confirmada", categoryId: "cat-casa", categoryKind: "gasto" }),
      tx("iber3", { provider: "IBERDROLA CLIENTES", codeCommon: "03", concept: "RECIBO LUZ", amountCents: -5601n, opDate: "2026-04-06", status: "confirmada", categoryId: "cat-casa", categoryKind: "gasto" }),
      tx("pp", { provider: "PAYPAL *STEAM GAMES 4029357733", amountCents: -1999n, status: "confirmada" }),
      tx("amexPay", { accountId: "amex1", amountCents: 50000n, concept: "Recibo enviado a su banco", opDate: "2026-06-10" }),
      tx("amexChg", { amountCents: -50000n, provider: "AMERICAN EXPRESS EUROPE", concept: "ADEUDO SEPA", opDate: "2026-06-11" }),
      tx("invChg", { amountCents: -25000n, concept: "TRANSFERENCIAS | 2860 56 0001234 APORTACION", provider: "BENEFICIARIO", codeCommon: "04", codeOwn: "073", opDate: "2026-06-12" }),
      tx("trOut", { amountCents: -30000n, concept: "TRASPASO A CUENTA AZUL Padre Ejemplo", opDate: "2026-06-15" }),
      tx("trIn", { accountId: "a2", amountCents: 30000n, concept: "ABONO RECIBIDO", opDate: "2026-06-16" }),
      tx("cash", { amountCents: -6000n, concept: "REINT. CAJERO 1234", opDate: "2026-06-18" }),
      tx("bizum", { amountCents: -1500n, provider: "MARIA GARCIA LOPEZ", concept: "BIZUM | Cena viernes", status: "confirmada", opDate: "2026-06-20" }),
    ],
  };
}

describe("runPipelineSteps: los 8 pasos en el orden del origen", () => {
  it("fija el orden canónico", () => {
    expect([...PIPELINE_ORDER]).toEqual([
      "reglas", "alias_paypal", "amex", "inversiones",
      "transferencias", "efectivo", "recurrencia", "reglas_evento",
    ]);
  });

  it("caso integral: cada paso actúa sobre el resultado del anterior", () => {
    const state = buildState();
    let seq = 0;
    const { report, changes } = runPipelineSteps(state, () => `id-${(seq += 1)}`);
    const byId = new Map(state.txs.map((t) => [t.id, t]));

    expect(report.steps.map((s) => s.name)).toEqual([...PIPELINE_ORDER]);
    expect(report.steps.map((s) => s.affected)).toEqual([1, 1, 1, 1, 2, 1, 6, 1]);

    // 1. reglas: solo la pendiente
    expect(byId.get("iber1")).toMatchObject({ status: "sugerida_regla", categoryId: "cat-casa" });
    // 2. alias PayPal
    expect(changes.insertedAliases).toEqual([
      { providerNorm: "PAYPAL *STEAM GAMES 4029357733", display: "Steam Games [PayPal]" },
    ]);
    // 3. Amex ANTES que transferencias: el par queda conciliado, no «robado»
    expect(byId.get("amexPay")?.transferGroupId).toBe(byId.get("amexChg")?.transferGroupId);
    expect(byId.get("amexChg")).toMatchObject({ status: "confirmada", categoryId: "cat-tr" });
    // 4. inversión: espejo insertado con hash invmirror- y cargo agrupado
    expect(changes.insertedTxs).toHaveLength(1);
    expect(changes.insertedTxs[0]).toMatchObject({
      accountId: "inv1", sourceTxId: "invChg", amountCents: 25000n,
      dedupHash: "invmirror-h-invChg", status: "confirmada",
    });
    expect(byId.get("invChg")).toMatchObject({ status: "confirmada", categoryId: "cat-tr" });
    // 5. transferencias: el traspaso con alias queda confirmado
    expect(byId.get("trOut")?.transferGroupId).toBe(byId.get("trIn")?.transferGroupId);
    expect(byId.get("trOut")?.status).toBe("confirmada");
    // 6. efectivo: crea la categoría «Efectivo» y confirma la retirada
    expect(changes.insertedCategories).toEqual([
      { id: expect.any(String), parentId: null, name: "Efectivo", kind: "gasto" },
    ]);
    expect(byId.get("cash")?.status).toBe("confirmada");
    // 7. recurrencia: 3 meses de Iberdrola ⇒ recurrente; sueltas ⇒ extraordinario
    expect(byId.get("iber1")?.recurrence).toBe("recurrente");
    expect(byId.get("cash")?.recurrence).toBe("extraordinario");
    // 8. reglas de evento al final, sobre el estado ya agrupado
    expect(changes.insertedTxEvents).toEqual([{ txId: "bizum", eventId: "ev1" }]);
  });

  it("es idempotente: una segunda pasada no propone nada nuevo", () => {
    const state = buildState();
    let seq = 0;
    runPipelineSteps(state, () => `id-${(seq += 1)}`);
    const second = runPipelineSteps(state, () => `id-${(seq += 1)}`);
    expect(second.changes.insertedTxs).toHaveLength(0);
    expect(second.changes.insertedAliases).toHaveLength(0);
    expect(second.changes.insertedTxEvents).toHaveLength(0);
    expect(second.report.steps.map((s) => s.affected)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("un hogar sin categoría raíz de transferencia no revienta: se crea al vuelo", () => {
    // El esquema garantiza COMO MUCHO una raíz (índice parcial único), no su
    // existencia: un hogar recién activado puede llegar aquí sin ella.
    const state = buildState();
    state.categories = state.categories.filter((c) => c.kind !== "transferencia");
    let seq = 0;
    const { changes } = runPipelineSteps(state, () => `id-${(seq += 1)}`);
    const creada = changes.insertedCategories.find((c) => c.kind === "transferencia");
    expect(creada).toMatchObject({ parentId: null, name: "Transferencias", kind: "transferencia" });
    const byId = new Map(state.txs.map((t) => [t.id, t]));
    expect(byId.get("trOut")?.categoryId).toBe(creada?.id);
    // y se reutiliza: una sola raíz para todas las patas de la pasada
    expect(changes.insertedCategories.filter((c) => c.kind === "transferencia")).toHaveLength(1);
  });
});

describe("runPostImportPipeline: carga y persistencia SQL (cliente simulado)", () => {
  it("carga el estado, ejecuta los pasos y emite los UPDATE", async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const txRow = {
      id: "iber1", account_id: "a1", op_date: "2026-06-10", concept: "RECIBO LUZ",
      provider: "IBERDROLA CLIENTES", provider_norm: "IBERDROLA CLIENTES",
      amount_cents: "-5512", category_id: null, status: "pendiente",
      transfer_group_id: null, recurrence: null, recurrence_manual: false,
      dedup_hash: "h1", code_common: "03", code_own: null, category_kind: null,
    };
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        const s = sql.trim().toLowerCase();
        if (s.startsWith("select")) {
          if (s.includes("from app.finance_transactions")) return { rows: [txRow] };
          if (s.includes("from app.finance_accounts"))
            return { rows: [{ id: "a1", name: "Caixa", bank: "caixabank", kind: "comun", bank_ref: "r1", owner_aliases: [], transfer_refs: [] }] };
          if (s.includes("from app.finance_categories"))
            return { rows: [{ id: "cat-casa", parent_id: null, name: "Casa", kind: "gasto" }, { id: "cat-tr", parent_id: null, name: "Transferencias internas", kind: "transferencia" }] };
          if (s.includes("from app.finance_rules"))
            return { rows: [{ id: "r1", rule_type: "proveedor_exacto", pattern: "IBERDROLA CLIENTES", category_id: "cat-casa", priority: 0 }] };
          if (s.includes("from app.finance_event_rules")) return { rows: [] };
          if (s.includes("from app.finance_provider_aliases")) return { rows: [] };
          if (s.includes("from app.finance_transaction_events")) return { rows: [] };
        }
        writes.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    } as unknown as PoolClient;

    const report = await runPostImportPipeline(client, "hh-1");
    expect(report.steps[0]).toEqual({ name: "reglas", affected: 1 });
    const update = writes.find((w) => w.sql.includes("update app.finance_transactions"));
    expect(update?.params).toEqual(["hh-1", "iber1", "cat-casa", "sugerida_regla", null, "extraordinario"]);
  });
});
