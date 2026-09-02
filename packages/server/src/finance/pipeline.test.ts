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
  cashAccountIdOf,
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

  it("el alias de PayPal se decide sobre el proveedor NORMALIZADO", () => {
    // El origen filtraba con `provider LIKE "PAYPAL %"` en SQLite (renormalize.py:126).
    // Aquí el filtro tiene que mirar `normText(provider)`: un separador que no sea
    // el espacio ASCII —el NBSP que mete un exportador Windows— se colapsa antes
    // de comparar, y el `providerNorm` que se guarda ya es `normText(provider)`.
    const state = buildState();
    state.txs.push(tx("ppNbsp", { provider: "PAYPAL\u00a0*NETFLIX 1234567", amountCents: -1299n, status: "confirmada", opDate: "2026-06-21" }));
    let seq = 0;
    const { changes } = runPipelineSteps(state, () => `id-${(seq += 1)}`);
    expect(changes.insertedAliases).toContainEqual({
      providerNorm: "PAYPAL *NETFLIX 1234567", display: "Netflix [PayPal]",
    });
  });

  it("PAYPALGO no es PayPal: el filtro conserva el espacio como límite", () => {
    const state = buildState();
    state.txs.push(tx("ppFalso", { provider: "PAYPALGO SERVICIOS", amountCents: -500n, status: "confirmada", opDate: "2026-06-22" }));
    let seq = 0;
    const { changes } = runPipelineSteps(state, () => `id-${(seq += 1)}`);
    expect(changes.insertedAliases.map((a) => a.providerNorm)).not.toContain("PAYPALGO SERVICIOS");
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

interface FakeTxRow {
  id: string; account_id: string; op_date: string; concept: string;
  provider: string | null; provider_norm: string | null; amount_cents: string;
  category_id: string | null; status: string; transfer_group_id: string | null;
  recurrence: string | null; recurrence_manual: boolean; dedup_hash: string;
  code_common: string | null; code_own: string | null; category_kind: string | null;
}
interface FakeAccountRow {
  id: string; name: string; bank: string | null; kind: string;
  bank_ref: string | null; owner_aliases: string[] | null; transfer_refs: string[] | null;
}
interface FakeRuleRow {
  id: string; rule_type: string; pattern: string; category_id: string; priority: number;
}
interface FakeCategoryRow { id: string; parent_id: string | null; name: string; kind: string }
interface Write { sql: string; params: unknown[] }

/** Cliente de mentira: responde a los SELECT del `loadPipelineState` y apunta las
 * escrituras. `rowCount` se calcula del propio parámetro para que las
 * comprobaciones de recuento del persistidor vean un servidor coherente. */
function fakeClient(
  data: {
    txs: FakeTxRow[]; accounts: FakeAccountRow[]; categories: FakeCategoryRow[];
    rules: FakeRuleRow[];
  },
  writes: Write[],
  rowCountOverride?: number,
): PoolClient {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const s = sql.trim().toLowerCase();
      if (s.startsWith("select")) {
        if (s.includes("from app.finance_transactions")) return { rows: data.txs };
        if (s.includes("from app.finance_accounts")) return { rows: data.accounts };
        if (s.includes("from app.finance_categories")) return { rows: data.categories };
        if (s.includes("from app.finance_rules")) return { rows: data.rules };
        if (s.includes("from app.finance_event_rules")) return { rows: [] };
        if (s.includes("from app.finance_provider_aliases")) return { rows: [] };
        if (s.includes("from app.finance_transaction_events")) return { rows: [] };
      }
      writes.push({ sql, params });
      const ids = params[1];
      const natural = Array.isArray(ids) ? ids.length : 1;
      return { rows: [], rowCount: rowCountOverride ?? natural };
    },
  } as unknown as PoolClient;
}

const ONE_TX: FakeTxRow = {
  id: "iber1", account_id: "a1", op_date: "2026-06-10", concept: "RECIBO LUZ",
  provider: "IBERDROLA CLIENTES", provider_norm: "IBERDROLA CLIENTES",
  amount_cents: "-5512", category_id: null, status: "pendiente",
  transfer_group_id: null, recurrence: null, recurrence_manual: false,
  dedup_hash: "h1", code_common: "03", code_own: null, category_kind: null,
};
const ONE_ACCOUNT: FakeAccountRow = {
  id: "a1", name: "Caixa", bank: "caixabank", kind: "comun", bank_ref: "r1",
  owner_aliases: [], transfer_refs: [],
};
const TWO_CATEGORIES: FakeCategoryRow[] = [
  { id: "cat-casa", parent_id: null, name: "Casa", kind: "gasto" },
  { id: "cat-tr", parent_id: null, name: "Transferencias internas", kind: "transferencia" },
];
const ONE_RULE: FakeRuleRow = {
  id: "r1", rule_type: "proveedor_exacto", pattern: "IBERDROLA CLIENTES",
  category_id: "cat-casa", priority: 0,
};

describe("runPostImportPipeline: carga y persistencia SQL (cliente simulado)", () => {
  it("carga el estado, ejecuta los pasos y emite el UPDATE por conjuntos", async () => {
    const writes: Write[] = [];
    const client = fakeClient(
      { txs: [ONE_TX], accounts: [ONE_ACCOUNT], categories: TWO_CATEGORIES, rules: [ONE_RULE] },
      writes,
    );

    const report = await runPostImportPipeline(client, "hh-1");
    expect(report.steps[0]).toEqual({ name: "reglas", affected: 1 });
    const update = writes.find((w) => w.sql.includes("update app.finance_transactions"));
    expect(update?.params).toEqual([
      "hh-1", ["iber1"], ["cat-casa"], ["sugerida_regla"], [null], ["extraordinario"],
    ]);
  });

  it("una sola sentencia para N filas actualizadas y una sola para los espejos", async () => {
    // 4 filas a actualizar y 2 espejos en la misma pasada: la persistencia no
    // puede degenerar en 6 idas y vueltas dentro de la transacción autorizada.
    const txs: FakeTxRow[] = [
      { ...ONE_TX, id: "t-regla", concept: "COMPRA", provider: "Mercado Ejemplo", provider_norm: "MERCADO EJEMPLO", amount_cents: "-2350", dedup_hash: "h-regla", code_common: null },
      { ...ONE_TX, id: "t-inv1", concept: "TRASPASO FONDO GLOBAL MAYO", provider: null, provider_norm: null, amount_cents: "-12000", dedup_hash: "h-inv1", code_common: null },
      { ...ONE_TX, id: "t-inv2", concept: "TRASPASO FONDO GLOBAL JUNIO", provider: null, provider_norm: null, amount_cents: "-13000", dedup_hash: "h-inv2", code_common: null },
      { ...ONE_TX, id: "t-otro", concept: "OTRA COSA", provider: "Otro", provider_norm: "OTRO", amount_cents: "-400", dedup_hash: "h-otro", code_common: null },
    ];
    const accounts: FakeAccountRow[] = [
      ONE_ACCOUNT,
      { id: "inv1", name: "Fondo Global", bank: null, kind: "inversion", bank_ref: "INV-1", owner_aliases: [], transfer_refs: ["FONDO GLOBAL"] },
    ];
    const rules: FakeRuleRow[] = [
      { id: "r1", rule_type: "proveedor_exacto", pattern: "MERCADO EJEMPLO", category_id: "cat-casa", priority: 0 },
    ];
    const writes: Write[] = [];
    const client = fakeClient({ txs, accounts, categories: TWO_CATEGORIES, rules }, writes);

    await runPostImportPipeline(client, "hh-1");

    const updates = writes.filter((w) => w.sql.includes("update app.finance_transactions"));
    const inserts = writes.filter((w) => w.sql.includes("insert into app.finance_transactions"));
    expect(updates).toHaveLength(1);
    expect(inserts).toHaveLength(1);
    const updateParams = updates[0]?.params ?? [];
    expect(updateParams[0]).toBe("hh-1");
    expect(updateParams[1]).toEqual(["t-regla", "t-inv1", "t-inv2", "t-otro"]);
    expect(updateParams).toHaveLength(6); // hogar + id + las 4 columnas del bucle
    for (const column of updateParams.slice(1)) expect(column).toHaveLength(4);
    // Los importes de los espejos viajan como texto y el cast va en SQL.
    expect(inserts[0]?.params[1]).toEqual([expect.any(String), expect.any(String)]);
    expect(inserts[0]?.sql).toContain("::bigint[]");
    // Invariante de orden (m1): los espejos se insertan DESPUÉS de los UPDATE.
    expect(writes.indexOf(updates[0] as Write)).toBeLessThan(writes.indexOf(inserts[0] as Write));
  });

  it("si el UPDATE no toca todas las filas esperadas, aborta con el recuento", async () => {
    const writes: Write[] = [];
    const client = fakeClient(
      { txs: [ONE_TX], accounts: [ONE_ACCOUNT], categories: TWO_CATEGORIES, rules: [ONE_RULE] },
      writes,
      0,
    );
    await expect(runPostImportPipeline(client, "hh-1")).rejects.toThrow(/0 de 1/);
  });
});

describe("cashAccountIdOf: la cuenta de efectivo se reconoce por su referencia", () => {
  // El origen usa `CASH_REF = "EFECTIVO"` sobre `bank_ref` (cash.py:8), un campo
  // técnico invariable; el nombre lo edita el usuario desde Ajustes en la fase 5.
  const cuenta = (extra: Partial<FinanceAccountView>): FinanceAccountView => ({
    id: "cash", name: "Efectivo", bank: null, kind: "comun", bankRef: "EFECTIVO",
    ownerAliases: [], transferRefs: [], ...extra,
  });

  it("la encuentra por bankRef aunque el usuario la haya renombrado", () => {
    expect(cashAccountIdOf([cuenta({ name: "Caja de casa" })])).toBe("cash");
  });

  it("cae al nombre normalizado para las cuentas anteriores a esta regla", () => {
    expect(cashAccountIdOf([cuenta({ id: "vieja", bankRef: "OTRA", name: "Efectivo" })])).toBe("vieja");
  });

  it("sin cuenta de efectivo devuelve null", () => {
    expect(cashAccountIdOf([acc("a1", "caixabank", "comun")])).toBeNull();
  });

  it("renombrar la cuenta no la saca de las exclusiones de los pasos 4 y 6", () => {
    const state = buildState();
    const caja = state.accounts.find((a) => a.id === "cash");
    if (caja === undefined) throw new Error("la cuenta de efectivo falta en buildState()");
    caja.name = "Caja de casa"; // conserva bankRef: "EFECTIVO"
    // Un reintegro apuntado DENTRO de la propia cuenta de efectivo: si la cuenta
    // deja de reconocerse, el paso 6 lo recategoriza y lo confirma en silencio.
    state.txs.push(tx("desdeCaja", { accountId: "cash", amountCents: -4000n, concept: "REINT. CAJERO 9999", opDate: "2026-06-19" }));
    let seq = 0;
    const { report } = runPipelineSteps(state, () => `id-${(seq += 1)}`);
    const byId = new Map(state.txs.map((t) => [t.id, t]));
    expect(byId.get("desdeCaja")?.status).toBe("pendiente");
    expect(report.steps.find((s) => s.name === "efectivo")?.affected).toBe(1);
  });
});
