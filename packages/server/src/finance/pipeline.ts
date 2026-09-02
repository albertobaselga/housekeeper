import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import {
  assessRecurrence,
  detectCashMovements,
  detectInvestmentContributions,
  detectTransferPairs,
  matchEventRules,
  matchRule,
  normText,
  paypalVendor,
  reconcileAmex,
  type FinanceAccountView,
  type FinanceCategoryView,
  type FinanceEventRuleView,
  type FinanceProviderAliasView,
  type FinanceRecurrence,
  type FinanceRuleView,
  type FinanceTransactionStatus,
  type FinanceTxView,
  type TransferProposal,
} from "@housekeeper/domain/finance";

/** Orden FIJO del pipeline post-import (api.py:337-345 del origen; spec §6/§13).
 * En el origen estaba duplicado en api.py y cli.py: aquí una sola verdad. */
export const PIPELINE_ORDER = [
  "reglas",
  "alias_paypal",
  "amex",
  "inversiones",
  "transferencias",
  "efectivo",
  "recurrencia",
  "reglas_evento",
] as const;
export type PipelineStepName = (typeof PIPELINE_ORDER)[number];

export interface PipelineReport {
  /** UNIDAD de `affected` por paso (la fase 5 la muestra al usuario, así que no
   * se puede adivinar): `reglas` → transacciones recategorizadas; `alias_paypal`
   * → alias creados; `amex` → PAREJAS conciliadas; `inversiones` → espejos
   * creados; `transferencias` → PATAS recién agrupadas (como `transfers.py`: una
   * pata huérfana que conserva su grupo no cuenta); `efectivo` → retiradas
   * confirmadas; `recurrencia` → veredictos escritos; `reglas_evento` →
   * asignaciones nuevas. */
  steps: { name: PipelineStepName; affected: number }[];
}

export interface PipelineState {
  txs: FinanceTxView[];
  accounts: FinanceAccountView[];
  categories: FinanceCategoryView[];
  rules: FinanceRuleView[];
  eventRules: FinanceEventRuleView[];
  aliases: FinanceProviderAliasView[];
  txEvents: { txId: string; eventId: string }[];
}

export interface NewPipelineTx {
  id: string;
  accountId: string;
  sourceTxId: string; // hereda el batch_id de su cargo (deshacer el lote lo arrastra)
  opDate: string;
  concept: string;
  provider: string;
  providerNorm: string;
  amountCents: bigint;
  categoryId: string;
  status: "confirmada";
  transferGroupId: string;
  dedupHash: string;
}

export interface PipelineChanges {
  updatedTxs: Map<
    string,
    {
      categoryId: string | null;
      status: FinanceTransactionStatus;
      transferGroupId: string | null;
      recurrence: FinanceRecurrence;
    }
  >;
  insertedTxs: NewPipelineTx[];
  insertedAliases: FinanceProviderAliasView[];
  insertedCategories: FinanceCategoryView[];
  insertedTxEvents: { txId: string; eventId: string }[];
}

/** Cuenta «Efectivo» del hogar: sin banco (el CHECK de `finance_accounts.bank`
 * solo admite los cuatro bancos reales). Se reconoce por su REFERENCIA
 * (`CASH_REF = "EFECTIVO"` del origen, cash.py:8), que es un campo técnico
 * invariable, y no por el nombre, que el usuario edita desde Ajustes: si se
 * buscara por nombre, renombrarla a «Caja» dejaría de excluirla de los pasos 4 y
 * 6 y contaminaría la contabilidad de doble entrada sin ningún error visible. El
 * nombre queda solo como respaldo para las cuentas anteriores a esta regla.
 * El dominio no la deduce nunca: se le pasa el id (resolución canónica 6). */
export function cashAccountIdOf(accounts: readonly FinanceAccountView[]): string | null {
  const byRef = accounts.find((a) => a.bank === null && a.bankRef === "EFECTIVO");
  if (byRef) return byRef.id;
  const byName = accounts.find((a) => a.bank === null && normText(a.name) === "EFECTIVO");
  return byName?.id ?? null;
}

/** Núcleo PURO del pipeline: muta `state` en memoria y acumula los cambios a
 * persistir. Testeable sin base de datos (caso integral en pipeline.test.ts). */
export function runPipelineSteps(
  state: PipelineState,
  newId: () => string,
): { report: PipelineReport; changes: PipelineChanges } {
  const changes: PipelineChanges = {
    updatedTxs: new Map(),
    insertedTxs: [],
    insertedAliases: [],
    insertedCategories: [],
    insertedTxEvents: [],
  };
  const report: PipelineReport = { steps: [] };
  const byId = new Map(state.txs.map((t) => [t.id, t]));
  const kindOf = new Map(state.categories.map((c) => [c.id, c.kind]));
  const touch = (t: FinanceTxView): void => {
    changes.updatedTxs.set(t.id, {
      categoryId: t.categoryId,
      status: t.status,
      transferGroupId: t.transferGroupId,
      recurrence: t.recurrence,
    });
  };
  const setCategory = (t: FinanceTxView, categoryId: string): void => {
    t.categoryId = categoryId;
    t.categoryKind = kindOf.get(categoryId) ?? t.categoryKind;
  };
  /** Raíz de transferencias del hogar. El esquema garantiza COMO MUCHO una
   * (índice parcial único), NO su existencia: un hogar que estrena Finanzas
   * puede no tenerla. Se crea al vuelo, igual que la categoría «Efectivo» del
   * paso 6, en lugar de abortar la transacción autorizada. */
  const transferCatId = (): string => {
    const found = state.categories.find((c) => c.kind === "transferencia" && c.parentId === null);
    if (found !== undefined) return found.id;
    const created: FinanceCategoryView = {
      id: newId(),
      parentId: null,
      name: "Transferencias",
      kind: "transferencia",
    };
    state.categories.push(created);
    kindOf.set(created.id, "transferencia");
    changes.insertedCategories.push(created);
    return created.id;
  };
  /** Patas huérfanas (con grupo pero solas en él) ANTES de aplicar los cruces de
   * un paso: `transfers.py` calcula las «recién agrupadas» como
   * `{tx, other} - lone_ids`, así que una huérfana nunca cuenta aunque cambie de
   * grupo, y dos huérfanas emparejadas cuentan 0 (no 1, como haría comparar el
   * grupo anterior con el nuevo). */
  const loneLegIds = (): Set<string> => {
    const counts = new Map<string, number>();
    for (const t of state.txs) {
      if (t.transferGroupId !== null) {
        counts.set(t.transferGroupId, (counts.get(t.transferGroupId) ?? 0) + 1);
      }
    }
    return new Set(
      state.txs
        .filter((t) => t.transferGroupId !== null && counts.get(t.transferGroupId) === 1)
        .map((t) => t.id),
    );
  };
  /** Aplica un cruce; devuelve cuántas patas quedan RECIÉN agrupadas. */
  const applyPair = (p: TransferProposal, loneIds: ReadonlySet<string>): number => {
    const group = p.existingGroupId ?? newId();
    const catId = transferCatId();
    for (const legId of p.legIds) {
      const leg = byId.get(legId);
      if (leg === undefined) continue;
      leg.transferGroupId = group;
      setCategory(leg, catId);
      leg.status = p.status;
      touch(leg);
    }
    return p.legIds.filter((id) => !loneIds.has(id)).length;
  };

  // 1. reglas (rules_engine.apply_rules: solo pendientes).
  // `affected` = transacciones recategorizadas por una regla.
  let affected = 0;
  for (const t of state.txs) {
    if (t.status !== "pendiente") continue;
    const rule = matchRule(t, state.rules);
    if (rule === null) continue;
    setCategory(t, rule.categoryId);
    t.status = "sugerida_regla";
    touch(t);
    affected += 1;
  }
  report.steps.push({ name: "reglas", affected });

  // 2. alias PayPal (renormalize.create_paypal_aliases: nunca pisa alias existentes).
  // `affected` = alias creados.
  affected = 0;
  const existingAliases = new Set(state.aliases.map((a) => a.providerNorm));
  const seenProviders = new Set<string>();
  for (const t of state.txs) {
    // Sobre el proveedor NORMALIZADO, no sobre el crudo: el origen filtraba con
    // `provider LIKE "PAYPAL %"` en SQLite y aquí `providerNorm` ya es
    // `normText(provider)`. El espacio final del literal es el límite de palabra
    // que impide que «PAYPALGO» entre; sin él, `startsWith("PAYPAL")` lo cogería.
    if (t.provider === null || !normText(t.provider).startsWith("PAYPAL ")) continue;
    const vendor = paypalVendor(t.provider);
    const pn = normText(t.provider);
    if (vendor === null || seenProviders.has(pn) || existingAliases.has(pn)) continue;
    seenProviders.add(pn);
    const alias = { providerNorm: pn, display: `${vendor} [PayPal]` };
    state.aliases.push(alias);
    changes.insertedAliases.push(alias);
    affected += 1;
  }
  report.steps.push({ name: "alias_paypal", affected });

  // 3. conciliación Amex (antes que transferencias: el cargo no debe ser «robado»).
  // Aquí `affected` cuenta PAREJAS conciliadas, no patas (ver PipelineReport).
  affected = 0;
  const amexLoneIds = loneLegIds();
  for (const p of reconcileAmex(state.txs, state.accounts)) {
    applyPair(p, amexLoneIds);
    affected += 1;
  }
  report.steps.push({ name: "amex", affected });

  // 4. inversiones: espejo confirmado agrupado con el cargo (hash invmirror-).
  // `cashAccountId` explícito: el esquema no admite bank='efectivo'/'inversion'.
  // `affected` = espejos creados.
  affected = 0;
  const cashAccountId = cashAccountIdOf(state.accounts);
  for (const p of detectInvestmentContributions(state.txs, state.accounts, { cashAccountId })) {
    const charge = byId.get(p.chargeTxId);
    if (charge === undefined) continue;
    const group = newId();
    const catId = transferCatId();
    const mirror: FinanceTxView = {
      id: newId(),
      accountId: p.investmentAccountId,
      opDate: p.mirrorOpDate,
      concept: p.mirrorConcept,
      provider: p.mirrorProvider,
      providerNorm: normText(p.mirrorProvider),
      amountCents: p.mirrorAmountCents,
      categoryId: catId,
      status: "confirmada",
      transferGroupId: group,
      recurrence: null,
      recurrenceManual: false,
      dedupHash: p.mirrorDedupHash,
      codeCommon: null,
      codeOwn: null,
      categoryKind: "transferencia",
    };
    state.txs.push(mirror);
    byId.set(mirror.id, mirror);
    changes.insertedTxs.push({
      id: mirror.id,
      accountId: mirror.accountId,
      sourceTxId: p.chargeTxId,
      opDate: mirror.opDate,
      concept: mirror.concept,
      provider: p.mirrorProvider,
      providerNorm: normText(p.mirrorProvider),
      amountCents: mirror.amountCents,
      categoryId: catId,
      status: "confirmada",
      transferGroupId: group,
      dedupHash: mirror.dedupHash,
    });
    charge.transferGroupId = group;
    setCategory(charge, catId);
    charge.status = "confirmada";
    touch(charge);
    affected += 1;
  }
  report.steps.push({ name: "inversiones", affected });

  // 5. transferencias: aquí `affected` cuenta PATAS recién agrupadas.
  affected = 0;
  const transferLoneIds = loneLegIds();
  for (const p of detectTransferPairs(state.txs, state.accounts)) {
    affected += applyPair(p, transferLoneIds);
  }
  report.steps.push({ name: "transferencias", affected });

  // 6. efectivo (cash.detect_cash_withdrawals + efectivo_category_id: crea la
  // categoría si falta). Este paso SOLO recategoriza retiradas de cajero: la
  // contrapartida de doble entrada (`cashpair-`) la produce `cashCounterlegFor`
  // desde el comando `finance.transaction.manual.create` de la fase 5, nunca aquí.
  // `affected` = retiradas confirmadas.
  affected = 0;
  const cashProposals = detectCashMovements(state.txs, state.accounts, { cashAccountId });
  if (cashProposals.length > 0) {
    let efectivo = state.categories.find((c) => c.kind === "gasto" && c.name === "Efectivo");
    if (efectivo === undefined) {
      efectivo = { id: newId(), parentId: null, name: "Efectivo", kind: "gasto" };
      state.categories.push(efectivo);
      kindOf.set(efectivo.id, "gasto");
      changes.insertedCategories.push(efectivo);
    }
    for (const p of cashProposals) {
      const t = byId.get(p.txId);
      if (t === undefined) continue;
      setCategory(t, efectivo.id);
      t.status = "confirmada";
      touch(t);
      affected += 1;
    }
  }
  report.steps.push({ name: "efectivo", affected });

  // 7. recurrencia (respeta recurrence_manual y las patas agrupadas).
  // `affected` = veredictos escritos.
  affected = 0;
  for (const v of assessRecurrence(state.txs)) {
    const t = byId.get(v.txId);
    if (t === undefined) continue;
    t.recurrence = v.recurrence;
    touch(t);
    affected += 1;
  }
  report.steps.push({ name: "recurrencia", affected });

  // 8. reglas de evento (asignación idempotente por par).
  // `affected` = asignaciones nuevas.
  affected = 0;
  const existing = new Set(state.txEvents.map((te) => `${te.txId}:${te.eventId}`));
  for (const p of matchEventRules(state.txs, state.eventRules, {
    categories: state.categories,
    aliases: state.aliases,
    existingAssignments: existing,
  })) {
    state.txEvents.push(p);
    changes.insertedTxEvents.push(p);
    affected += 1;
  }
  report.steps.push({ name: "reglas_evento", affected });

  return { report, changes };
}

interface TxRow {
  id: string; account_id: string; op_date: string; concept: string;
  provider: string | null; provider_norm: string | null; amount_cents: string;
  category_id: string | null; status: FinanceTransactionStatus;
  transfer_group_id: string | null; recurrence: FinanceRecurrence;
  recurrence_manual: boolean; dedup_hash: string; code_common: string | null;
  code_own: string | null; category_kind: FinanceCategoryView["kind"] | null;
}

async function loadPipelineState(client: PoolClient, householdId: string): Promise<PipelineState> {
  const txRes = await client.query<TxRow>(
    `select t.id, t.account_id, t.op_date::text as op_date, t.concept, t.provider,
            t.provider_norm, t.amount_cents::text as amount_cents, t.category_id,
            t.status, t.transfer_group_id, t.recurrence, t.recurrence_manual,
            t.dedup_hash, t.code_common, t.code_own, c.kind as category_kind
       from app.finance_transactions t
       left join app.finance_categories c
         on c.household_id = t.household_id and c.id = t.category_id
      where t.household_id = $1`,
    [householdId],
  );
  // `bank_ref` es NULLABLE en el esquema (cuentas manuales sin referencia de banco).
  const accRes = await client.query<{
    id: string; name: string; bank: FinanceAccountView["bank"]; kind: FinanceAccountView["kind"];
    bank_ref: string | null; owner_aliases: string[] | null; transfer_refs: string[] | null;
  }>(
    `select id, name, bank, kind, bank_ref, owner_aliases, transfer_refs
       from app.finance_accounts where household_id = $1`,
    [householdId],
  );
  const catRes = await client.query<{ id: string; parent_id: string | null; name: string; kind: FinanceCategoryView["kind"] }>(
    `select id, parent_id, name, kind from app.finance_categories where household_id = $1`,
    [householdId],
  );
  const ruleRes = await client.query<{ id: string; rule_type: FinanceRuleView["ruleType"]; pattern: string; category_id: string; priority: number }>(
    `select id, rule_type, pattern, category_id, priority
       from app.finance_rules where household_id = $1`,
    [householdId],
  );
  // `provider_norm` es NULLABLE en app.finance_event_rules (reglas por categoría).
  const evRuleRes = await client.query<{ id: string; provider_norm: string | null; concept_norm: string | null; category_id: string | null; event_id: string }>(
    `select id, provider_norm, concept_norm, category_id, event_id
       from app.finance_event_rules where household_id = $1`,
    [householdId],
  );
  const aliasRes = await client.query<{ provider_norm: string; display: string }>(
    `select provider_norm, display from app.finance_provider_aliases where household_id = $1`,
    [householdId],
  );
  const teRes = await client.query<{ transaction_id: string; event_id: string }>(
    `select transaction_id, event_id from app.finance_transaction_events where household_id = $1`,
    [householdId],
  );
  return {
    txs: txRes.rows.map((r) => ({
      id: r.id, accountId: r.account_id, opDate: r.op_date, concept: r.concept,
      provider: r.provider, providerNorm: r.provider_norm,
      amountCents: BigInt(r.amount_cents), categoryId: r.category_id, status: r.status,
      transferGroupId: r.transfer_group_id, recurrence: r.recurrence,
      recurrenceManual: r.recurrence_manual, dedupHash: r.dedup_hash,
      codeCommon: r.code_common, codeOwn: r.code_own, categoryKind: r.category_kind,
    })),
    accounts: accRes.rows.map((r) => ({
      id: r.id, name: r.name, bank: r.bank, kind: r.kind, bankRef: r.bank_ref ?? "",
      ownerAliases: r.owner_aliases ?? [], transferRefs: r.transfer_refs ?? [],
    })),
    categories: catRes.rows.map((r) => ({ id: r.id, parentId: r.parent_id, name: r.name, kind: r.kind })),
    rules: ruleRes.rows.map((r) => ({ id: r.id, ruleType: r.rule_type, pattern: r.pattern, categoryId: r.category_id, priority: r.priority })),
    eventRules: evRuleRes.rows.map((r) => ({ id: r.id, providerNorm: r.provider_norm, conceptNorm: r.concept_norm, categoryId: r.category_id, eventId: r.event_id })),
    aliases: aliasRes.rows.map((r) => ({ providerNorm: r.provider_norm, display: r.display })),
    txEvents: teRes.rows.map((r) => ({ txId: r.transaction_id, eventId: r.event_id })),
  };
}

async function persistPipelineChanges(
  client: PoolClient,
  householdId: string,
  changes: PipelineChanges,
): Promise<void> {
  for (const cat of changes.insertedCategories) {
    await client.query(
      `insert into app.finance_categories (household_id, id, parent_id, name, kind)
       values ($1, $2, $3, $4, $5)`,
      [householdId, cat.id, cat.parentId, cat.name, cat.kind],
    );
  }
  // UNA sola sentencia para todas las filas cambiadas. `updatedTxs` no está
  // acotado —el paso 7 emite un veredicto por cada transacción del hogar cuyo
  // valor cambie, y la primera pasada tras migrar años de datos son decenas de
  // miles—, así que un UPDATE por fila serían decenas de miles de idas y vueltas
  // seguidas dentro de la transacción autorizada; la fase 5 llama a esto desde el
  // handler HTTP de confirmación de importación, con límite de ejecución.
  if (changes.updatedTxs.size > 0) {
    const ids: string[] = [];
    const categoryIds: (string | null)[] = [];
    const statuses: string[] = [];
    const transferGroupIds: (string | null)[] = [];
    const recurrences: (string | null)[] = [];
    for (const [id, u] of changes.updatedTxs) {
      ids.push(id);
      categoryIds.push(u.categoryId);
      statuses.push(u.status);
      transferGroupIds.push(u.transferGroupId);
      recurrences.push(u.recurrence);
    }
    const updated = await client.query(
      `update app.finance_transactions t
          set category_id = u.category_id, status = u.status,
              transfer_group_id = u.transfer_group_id, recurrence = u.recurrence
         from unnest($2::uuid[], $3::uuid[], $4::text[], $5::uuid[], $6::text[])
              as u(id, category_id, status, transfer_group_id, recurrence)
        where t.household_id = $1 and t.id = u.id`,
      [householdId, ids, categoryIds, statuses, transferGroupIds, recurrences],
    );
    // Sin esto, una fila que ya no exista (o que sea de otro hogar) se traduce en
    // un UPDATE de menos filas SIN error, y el informe seguiría contándola.
    if (updated.rowCount !== ids.length) {
      throw new Error(
        `el pipeline actualizó ${updated.rowCount ?? 0} de ${ids.length} transacciones del hogar`,
      );
    }
  }
  // Los espejos se insertan DESPUÉS de los UPDATE, y de ahí la invariante que
  // sostiene todo esto: un espejo NUNCA aparece en `updatedTxs`. Los pasos 5 a 8
  // lo ven en `state.txs` pero ninguno lo toca (transferencias y recurrencia
  // saltan los agrupados, efectivo exige importe negativo y el espejo es
  // positivo); si algún paso futuro lo tocara, su UPDATE se ejecutaría antes de
  // que la fila existiera y se perdería en silencio. El `join` con la fila origen
  // hereda su `batch_id`: deshacer el lote arrastra también el espejo.
  if (changes.insertedTxs.length > 0) {
    const ids: string[] = [];
    const accountIds: string[] = [];
    const sourceTxIds: string[] = [];
    const opDates: string[] = [];
    const concepts: string[] = [];
    const providers: string[] = [];
    const providerNorms: string[] = [];
    const amountCents: string[] = [];
    const categoryIds: string[] = [];
    const statuses: string[] = [];
    const transferGroupIds: string[] = [];
    const dedupHashes: string[] = [];
    for (const t of changes.insertedTxs) {
      ids.push(t.id);
      accountIds.push(t.accountId);
      sourceTxIds.push(t.sourceTxId);
      opDates.push(t.opDate);
      concepts.push(t.concept);
      providers.push(t.provider);
      providerNorms.push(t.providerNorm);
      amountCents.push(t.amountCents.toString()); // bigint viaja como texto; el cast va en SQL
      categoryIds.push(t.categoryId);
      statuses.push(t.status);
      transferGroupIds.push(t.transferGroupId);
      dedupHashes.push(t.dedupHash);
    }
    const inserted = await client.query(
      `insert into app.finance_transactions
         (household_id, id, account_id, batch_id, op_date, concept, provider,
          provider_norm, amount_cents, category_id, status, transfer_group_id,
          dedup_hash, recurrence_manual, raw)
       select $1, n.id, n.account_id, src.batch_id, n.op_date, n.concept, n.provider,
              n.provider_norm, n.amount_cents, n.category_id, n.status,
              n.transfer_group_id, n.dedup_hash, false, '{}'::jsonb
         from unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::date[], $6::text[],
                     $7::text[], $8::text[], $9::bigint[], $10::uuid[], $11::text[],
                     $12::uuid[], $13::text[])
              as n(id, account_id, source_tx_id, op_date, concept, provider,
                   provider_norm, amount_cents, category_id, status,
                   transfer_group_id, dedup_hash)
         join app.finance_transactions src
           on src.household_id = $1 and src.id = n.source_tx_id`,
      [householdId, ids, accountIds, sourceTxIds, opDates, concepts, providers,
        providerNorms, amountCents, categoryIds, statuses, transferGroupIds, dedupHashes],
    );
    // El `join` no inserta nada si la fila origen no existe: sin esta comprobación
    // el cargo se quedaría en un grupo de transferencia de una sola pata mientras
    // el informe anuncia «inversiones: N».
    if (inserted.rowCount !== ids.length) {
      throw new Error(
        `el pipeline insertó ${inserted.rowCount ?? 0} de ${ids.length} espejos de inversión`,
      );
    }
  }
  for (const a of changes.insertedAliases) {
    await client.query(
      `insert into app.finance_provider_aliases (household_id, provider_norm, display)
       values ($1, $2, $3) on conflict do nothing`,
      [householdId, a.providerNorm, a.display],
    );
  }
  for (const te of changes.insertedTxEvents) {
    await client.query(
      `insert into app.finance_transaction_events (household_id, transaction_id, event_id)
       values ($1, $2, $3) on conflict do nothing`,
      [householdId, te.txId, te.eventId],
    );
  }
}

/** Pipeline post-import unificado. Se ejecuta DENTRO de la transacción
 * autorizada (withAuthorizedTransaction) tras insertar un lote. */
export async function runPostImportPipeline(
  client: PoolClient,
  householdId: string,
): Promise<PipelineReport> {
  const state = await loadPipelineState(client, householdId);
  const { report, changes } = runPipelineSteps(state, () => randomUUID());
  await persistPipelineChanges(client, householdId, changes);
  return report;
}
