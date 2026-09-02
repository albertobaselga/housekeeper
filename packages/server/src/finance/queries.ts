import type { PoolClient } from "pg";

// SUBPATH obligatorio: la raíz @housekeeper/domain no reexporta finanzas.
import {
  computeRangeSummary,
  type FinanceAccountView,
  type FinanceCategoryKind,
  type FinanceRecurrence,
  type FinanceTransactionStatus,
  type FinanceTxView,
  type PivotSourceRow,
  type RangeSummary,
  type SummaryOptions,
} from "@housekeeper/domain/finance";

/**
 * Lecturas SQL del módulo Finanzas (§7 de la spec), compartidas por los loads
 * de las páginas y por los endpoints GET /api/v1/finance/*. TODO corre dentro
 * de withAuthorizedTransaction: es la RLS (doble cerrojo de §4) quien decide
 * qué filas existen; estas consultas solo dan forma. Céntimos: bigint en SQL,
 * string en el DTO de cable, BigInt solo para operar. Jamás Number.
 */

export interface FinanceReadFilters {
  from: string;
  to: string;
  accountIds: string[];
  eventId: string | null;
  excludeEventIds: string[];
}

export interface FinanceAccountDto { id: string; name: string; bank: string; kind: string; ownerLabel: string; archived: boolean }
export interface FinanceCategoryDto { id: string; name: string; parentId: string | null; kind: string }
export interface FinanceEventDto { id: string; name: string }

export interface FinanceTxDto {
  id: string; accountId: string; accountName: string; opDate: string; valueDate: string | null;
  concept: string; provider: string | null; providerNorm: string | null; providerDisplay: string | null;
  amountCents: string; balanceCents: string | null; codeCommon: string | null; codeOwn: string | null;
  categoryId: string | null; categoryName: string | null; status: string; transferGroupId: string | null;
  recurrence: "recurrente" | "extraordinario" | null; recurrenceManual: boolean;
  bankCategory: string | null; eventIds: string[]; raw: Record<string, string> | null;
}

export interface FinanceTransactionsQuery extends FinanceReadFilters {
  q: string | null;
  categoryId: string | null;
  recurrence: "recurrente" | "extraordinario" | null;
  status: string | null;
  ids: string[];
  groupIds: string[];
  limit: number;
  offset: number;
}

export interface FinanceTransactionsPage {
  total: number;
  sumCents: string;
  limit: number;
  offset: number;
  rows: FinanceTxDto[];
}

// ── Helpers puros de rango ───────────────────────────────────────────────────
//
// Viven aquí y no en @housekeeper/domain porque packages/server no puede
// importar de apps/web ni al revés en este sentido: son helpers de fecha
// puramente mecánicos (partir/componer ISO, sumar meses) que solo usa
// seriesWindow, propio de esta lectura SQL.

// `??`/desestructuración con default solo cubren el elemento AUSENTE, no el
// malformado: "agosto".split("-").map(Number) da [NaN], que pasaría de largo y
// llegaría a SQL como fecha inválida. finiteOr cierra también ese caso.
function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function splitIso(iso: string): [number, number, number] {
  const [year, month, day] = iso.split("-").map(Number);
  return [finiteOr(year, 1970), finiteOr(month, 1), finiteOr(day, 1)];
}

function isoOf(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addMonths(year: number, month: number, delta: number): [number, number] {
  const index = year * 12 + (month - 1) + delta;
  return [Math.floor(index / 12), ((index % 12) + 12) % 12 + 1];
}

// El periodo anterior NO se calcula aquí: es prevRange de @housekeeper/domain/finance
// (fase 2) y computeRangeSummary ya lo aplica por dentro. Una segunda copia de
// esa regla en este fichero divergiría en silencio.

/** Día 1 del mes (months−1) meses antes del mes de `to`: la serie siempre mira hacia atrás. */
export function seriesWindow(to: string, months: number): string {
  const [year, month] = splitIso(to);
  const [startYear, startMonth] = addMonths(year, month, -(months - 1));
  return isoOf(startYear, startMonth, 1);
}

// ── Condiciones compartidas ──────────────────────────────────────────────────

interface SqlFilter { where: string; params: unknown[] }

/** Rango + cuentas + evento + exclusiones sobre el alias `tx` ($1 = householdId). */
function txConditions(householdId: string, filters: FinanceReadFilters): SqlFilter {
  const params: unknown[] = [householdId, filters.from, filters.to];
  const where: string[] = ["tx.household_id = $1", "tx.op_date >= $2", "tx.op_date <= $3"];
  if (filters.accountIds.length > 0) {
    params.push(filters.accountIds);
    where.push(`tx.account_id = any($${params.length}::uuid[])`);
  }
  if (filters.eventId) {
    params.push(filters.eventId);
    where.push(`exists (select 1 from app.finance_transaction_events te
                 where te.household_id = tx.household_id and te.transaction_id = tx.id
                   and te.event_id = $${params.length})`);
  }
  if (filters.excludeEventIds.length > 0) {
    params.push(filters.excludeEventIds);
    where.push(`not exists (select 1 from app.finance_transaction_events te
                 where te.household_id = tx.household_id and te.transaction_id = tx.id
                   and te.event_id = any($${params.length}::uuid[]))`);
  }
  return { where: where.join("\n     and "), params };
}

/**
 * Subconsulta con `kind` resuelto (el de la categoría; sin categoría, por el
 * signo) y SIN las patas de transferencia — el `_txs` del origen (reports.py).
 */
function kindedTx(where: string): string {
  return `
  select tx.*, case when cat.kind is not null then cat.kind::text
                    when tx.amount_cents > 0 then 'ingreso' else 'gasto' end as kind
    from app.finance_transactions tx
    left join app.finance_categories cat
      on cat.household_id = tx.household_id and cat.id = tx.category_id
   where ${where}
     and coalesce(cat.kind::text, '') <> 'transferencia'`;
}

// ── Catálogos ────────────────────────────────────────────────────────────────

export async function readFinanceAccounts(client: PoolClient, householdId: string): Promise<FinanceAccountDto[]> {
  const result = await client.query<FinanceAccountDto>(
    // `bank` es NULL para cuentas sin banco (Efectivo, manuales — 0036_finance.sql);
    // coalesce a '' para no mentir sobre el tipo `string` del DTO (ver hermana
    // readFinanceAccountViews, que hace lo mismo por la misma razón).
    `select account.id, account.name, coalesce(account.bank::text, '') as "bank", account.kind::text as "kind",
            account.owner_label as "ownerLabel", (account.archived_at is not null) as "archived"
       from app.finance_accounts account
      where account.household_id = $1
      order by account.name`,
    [householdId],
  );
  return result.rows;
}

export async function readFinanceCategories(client: PoolClient, householdId: string): Promise<FinanceCategoryDto[]> {
  const result = await client.query<FinanceCategoryDto>(
    `select category.id, category.name, category.parent_id as "parentId", category.kind::text as "kind"
       from app.finance_categories category
      where category.household_id = $1
      -- Orden plano, no de árbol: las raíces salen alfabéticas primero, luego
      -- bloques de hijas agrupadas por parent_id (uuid, sin orden visual). Si
      -- fase 5 necesita un árbol presentable, lo construye en memoria.
      order by category.parent_id nulls first, category.name`,
    [householdId],
  );
  return result.rows;
}

export async function readFinanceEvents(client: PoolClient, householdId: string): Promise<FinanceEventDto[]> {
  const result = await client.query<FinanceEventDto>(
    `select event.id, event.name from app.finance_events event
      where event.household_id = $1 order by lower(event.name)`,
    [householdId],
  );
  return result.rows;
}

// ── Movimientos con paginación explícita (§7: nunca truncar en silencio) ─────

/**
 * Alias del proveedor como subconsulta ESCALAR, nunca como join: el `limit 1`
 * deja el resultado inmune a la forma de la tabla aunque el UNIQUE
 * `(household_id, provider_norm)` de 0036_finance.sql ya lo garantice hoy — un
 * join con dos filas del mismo `provider_norm` duplicaría filas inflando
 * `total` y `sumCents` — justo el «total veraz» que esta lectura promete.
 */
const ALIAS_DISPLAY = `(select a.display
                          from app.finance_provider_aliases a
                         where a.household_id = tx.household_id
                           and a.provider_norm = tx.provider_norm
                         limit 1)`;

export async function readFinanceTransactions(
  client: PoolClient,
  householdId: string,
  query: FinanceTransactionsQuery,
): Promise<FinanceTransactionsPage> {
  const byIds = query.ids.length > 0 || query.groupIds.length > 0;
  // Cada rama construye sus propios `params`/`where` de cero: nada de mutar un
  // array ya inicializado para la otra rama (length = 0 obligaba a leer dos
  // veces para ver qué sobrevivía).
  let params: unknown[];
  let where: string[];
  if (byIds) {
    // Petición exacta (panel de detalle): sin rango ni filtros de periodo. Los
    // dos criterios se unen con OR dentro del MISMO paréntesis: la semántica es
    // «estos movimientos O los de estos grupos»; con AND casi siempre saldría
    // cero filas cuando el cliente combinara ambos (trampa latente para fase 5).
    params = [householdId];
    where = ["tx.household_id = $1"];
    const exact: string[] = [];
    if (query.ids.length > 0) {
      params.push(query.ids);
      exact.push(`tx.id = any($${params.length}::uuid[])`);
    }
    if (query.groupIds.length > 0) {
      params.push(query.groupIds);
      exact.push(`tx.transfer_group_id = any($${params.length}::uuid[])`);
    }
    where.push(`(${exact.join(" or ")})`);
  } else {
    const base = txConditions(householdId, query);
    params = [...base.params];
    where = [base.where];
  }
  if (query.q) {
    params.push(`%${query.q}%`);
    where.push(`(tx.concept ilike $${params.length} or tx.provider ilike $${params.length}
                 or coalesce(${ALIAS_DISPLAY}, '') ilike $${params.length})`);
  }
  if (query.categoryId) {
    params.push(query.categoryId);
    where.push(`tx.category_id = $${params.length}`);
  }
  if (query.recurrence) {
    params.push(query.recurrence);
    where.push(`tx.recurrence = $${params.length}`);
  }
  if (query.status) {
    params.push(query.status);
    where.push(`tx.status = $${params.length}`);
  }

  const fromSql = `
    from app.finance_transactions tx
    join app.finance_accounts account
      on account.household_id = tx.household_id and account.id = tx.account_id
    left join app.finance_categories cat
      on cat.household_id = tx.household_id and cat.id = tx.category_id
   where ${where.join("\n     and ")}`;

  // Total y suma en consulta propia: con offset fuera de rango la página no
  // trae filas y aun así el total debe ser veraz (nunca truncar en silencio).
  // total/limit/offset son contadores/paginación: Number es correcto aquí, no dinero.
  const totals = await client.query<{ total: number; sumCents: string }>(
    `select count(*)::int as "total", coalesce(sum(tx.amount_cents), 0)::text as "sumCents" ${fromSql}`,
    params,
  );

  // Sin `eventIds` todavía (se añade tras la consulta de finance_transaction_events):
  // TxRow es estructuralmente FinanceTxDto salvo ese campo, así que el `map` de
  // abajo no necesita ningún `as` — es una ampliación de tipo, no una aserción.
  type TxRow = Omit<FinanceTxDto, "eventIds">;
  const page = await client.query<TxRow>(
    `select tx.id, tx.account_id as "accountId", account.name as "accountName",
            tx.op_date::text as "opDate", tx.value_date::text as "valueDate",
            tx.concept, tx.provider, tx.provider_norm as "providerNorm",
            coalesce(${ALIAS_DISPLAY}, tx.provider) as "providerDisplay",
            tx.amount_cents::text as "amountCents", tx.balance_cents::text as "balanceCents",
            tx.code_common as "codeCommon", tx.code_own as "codeOwn",
            tx.category_id as "categoryId", cat.name as "categoryName",
            tx.status::text as "status", tx.transfer_group_id as "transferGroupId",
            tx.recurrence::text as "recurrence", tx.recurrence_manual as "recurrenceManual",
            tx.bank_category as "bankCategory", tx.raw
       ${fromSql}
      order by tx.op_date desc, tx.id desc
      limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, query.limit, query.offset],
  );

  const txIds = page.rows.map((row) => row.id);
  const eventsByTx = new Map<string, string[]>();
  if (txIds.length > 0) {
    const events = await client.query<{ transactionId: string; eventId: string }>(
      `select te.transaction_id as "transactionId", te.event_id as "eventId"
         from app.finance_transaction_events te
        where te.household_id = $1 and te.transaction_id = any($2::uuid[])`,
      [householdId, txIds],
    );
    for (const row of events.rows) {
      const list = eventsByTx.get(row.transactionId) ?? [];
      list.push(row.eventId);
      eventsByTx.set(row.transactionId, list);
    }
  }

  return {
    total: totals.rows[0]?.total ?? 0,
    sumCents: totals.rows[0]?.sumCents ?? "0",
    limit: query.limit,
    offset: query.offset,
    rows: page.rows.map((row) => ({ ...row, eventIds: eventsByTx.get(row.id) ?? [] })),
  };
}

// ── Lecturas agregadas (summary, series, desglose, proveedores, eventos) ─────

export interface FinanceSummaryDto {
  incomeCents: string;
  expenseCents: string;
  recurringExpenseCents: string;
  extraordinaryExpenseCents: string;
  unclassifiedExpenseCents: string;
  savingsCents: string;
  netSavingsRate: number | null;
  grossSavingsRate: number | null;
  investedCents: string;
  investmentRate: number | null;
  freeCashFlowCents: string;
  opsCashFlowCents: string;
  receivedContributionsCents: string;
  outgoingTransfersCents: string;
  pendingCount: number;
  prev: FinanceSummaryDto | null;
}

/** RangeSummary (bigint, canónico de fase 2) → DTO de cable (céntimos-string). */
export function serializeRangeSummary(summary: RangeSummary): FinanceSummaryDto {
  return {
    incomeCents: summary.incomeCents.toString(),
    expenseCents: summary.expenseCents.toString(),
    recurringExpenseCents: summary.recurringExpenseCents.toString(),
    extraordinaryExpenseCents: summary.extraordinaryExpenseCents.toString(),
    unclassifiedExpenseCents: summary.unclassifiedExpenseCents.toString(),
    savingsCents: summary.savingsCents.toString(),
    netSavingsRate: summary.netSavingsRate,
    grossSavingsRate: summary.grossSavingsRate,
    investedCents: summary.investedCents.toString(),
    investmentRate: summary.investmentRate,
    freeCashFlowCents: summary.freeCashFlowCents.toString(),
    opsCashFlowCents: summary.opsCashFlowCents.toString(),
    receivedContributionsCents: summary.receivedContributionsCents.toString(),
    outgoingTransfersCents: summary.outgoingTransfersCents.toString(),
    pendingCount: summary.pendingCount,
    prev: summary.prev ? serializeRangeSummary(summary.prev) : null,
  };
}

/** Cuentas con la forma que pide el dominio (`FinanceAccountView`), no el DTO de cable. */
async function readFinanceAccountViews(client: PoolClient, householdId: string): Promise<FinanceAccountView[]> {
  // `bank` viaja como NULL para efectivo/inversión/manuales (Ruling R3): el
  // dominio distingue esas cuentas por `kind`, nunca por `bank`, así que aquí
  // NO se coalesce a '' — el tipo es `FinanceBank | null` y hay que conservarlo.
  const result = await client.query<FinanceAccountView>(
    `select account.id, account.name, account.bank::text as "bank",
            account.kind::text as "kind", coalesce(account.bank_ref, '') as "bankRef",
            coalesce(account.owner_aliases, '[]'::jsonb) as "ownerAliases",
            coalesce(account.transfer_refs, '[]'::jsonb) as "transferRefs"
       from app.finance_accounts account
      where account.household_id = $1
      order by account.name`,
    [householdId],
  );
  return result.rows;
}

/**
 * Resumen del periodo. Trae TODAS las transacciones del hogar, sin ventana de
 * fechas: lo exige el productor (fase 2), porque `computeRangeSummary` filtra
 * por dentro y necesita el corpus completo para el periodo anterior, para las
 * patas de transferencia/inversión que cruzan el rango y para el `pendingCount`
 * global (el chip «N sin revisar» del Dashboard cuenta TODO el hogar, no el
 * periodo). Recortar la ventana aquí produce KPIs y pendientes falsos.
 */
export async function readFinanceSummary(
  client: PoolClient,
  householdId: string,
  filters: FinanceReadFilters,
): Promise<FinanceSummaryDto> {
  const txResult = await client.query<{
    id: string; accountId: string; opDate: string; concept: string; provider: string | null;
    providerNorm: string | null; amountCents: string; categoryId: string | null;
    status: FinanceTransactionStatus; transferGroupId: string | null;
    recurrence: FinanceRecurrence; recurrenceManual: boolean; dedupHash: string;
    codeCommon: string | null; codeOwn: string | null; categoryKind: FinanceCategoryKind | null;
  }>(
    // El join a categorías NO es decorativo: `categoryKind` es lo que usa el
    // dominio para excluir las patas 'transferencia' y para clasificar
    // ingreso/gasto. Sin él, todo traspaso interno entraría como ingreso o gasto.
    `select tx.id, tx.account_id as "accountId", tx.op_date::text as "opDate", tx.concept,
            tx.provider, tx.provider_norm as "providerNorm", tx.amount_cents::text as "amountCents",
            tx.category_id as "categoryId", tx.status::text as "status",
            tx.transfer_group_id as "transferGroupId", tx.recurrence::text as "recurrence",
            tx.recurrence_manual as "recurrenceManual", tx.dedup_hash as "dedupHash",
            tx.code_common as "codeCommon", tx.code_own as "codeOwn",
            cat.kind::text as "categoryKind"
       from app.finance_transactions tx
       left join app.finance_categories cat
         on cat.household_id = tx.household_id and cat.id = tx.category_id
      where tx.household_id = $1`,
    [householdId],
  );
  // Tipado explícito y SIN aserción `as`: si a `FinanceTxView` le falta o le
  // sobra un campo, el typecheck lo canta aquí, que es donde se arregla.
  const txs: FinanceTxView[] = txResult.rows.map((row) => ({ ...row, amountCents: BigInt(row.amountCents) }));

  const accounts = await readFinanceAccountViews(client, householdId);

  const eventRows = await client.query<{ transactionId: string; eventId: string }>(
    `select te.transaction_id as "transactionId", te.event_id as "eventId"
       from app.finance_transaction_events te
      where te.household_id = $1`,
    [householdId],
  );
  const eventIdsByTx = new Map<string, string[]>();
  for (const row of eventRows.rows) {
    const list = eventIdsByTx.get(row.transactionId) ?? [];
    list.push(row.eventId);
    eventIdsByTx.set(row.transactionId, list);
  }

  // ANOTADO, no aserido: `SummaryOptions` (fase 2) tiene EXACTAMENTE estos
  // campos; con `as` colarían nombres inventados en silencio y los filtros
  // ev/exev se perderían sin que nada protestara. El `kind` de la categoría ya
  // viaja en cada fila (`categoryKind`): no hay campo `categories`.
  const options: SummaryOptions = {
    from: filters.from,
    to: filters.to,
    accounts,
    accountIds: filters.accountIds,
    eventId: filters.eventId,
    excludeEventIds: filters.excludeEventIds,
    eventIdsByTx,
  };
  return serializeRangeSummary(computeRangeSummary(txs, options));
}

export interface FinanceSeriesPointDto { bucket: string; incomeCents: string; expenseCents: string; savingsCents: string }

export async function readFinanceSeries(
  client: PoolClient,
  householdId: string,
  filters: FinanceReadFilters,
  granularity: "month" | "quarter" | "year",
  months = 12,
): Promise<FinanceSeriesPointDto[]> {
  const windowed = { ...filters, from: seriesWindow(filters.to, months) };
  const { where, params } = txConditions(householdId, windowed);
  const bucketExpr =
    granularity === "year" ? `to_char(kt.op_date, 'YYYY')`
    : granularity === "quarter" ? `to_char(kt.op_date, 'YYYY-"T"Q')`
    : `to_char(kt.op_date, 'YYYY-MM')`;
  const result = await client.query<{ bucket: string; incomeCents: string; expenseCents: string }>(
    `with kt as (${kindedTx(where)})
     select ${bucketExpr} as "bucket",
            coalesce(sum(kt.amount_cents) filter (where kt.kind = 'ingreso'), 0)::text as "incomeCents",
            coalesce(sum(kt.amount_cents) filter (where kt.kind = 'gasto'), 0)::text as "expenseCents"
       from kt group by 1 order by 1`,
    params,
  );
  return result.rows.map((row) => ({
    ...row,
    savingsCents: (BigInt(row.incomeCents) + BigInt(row.expenseCents)).toString(),
  }));
}

export interface FinanceCategoryRowDto { categoryId: string | null; name: string; parentId: string | null; totalCents: string; count: number }

export async function readFinanceBreakdown(
  client: PoolClient,
  householdId: string,
  filters: FinanceReadFilters,
): Promise<FinanceCategoryRowDto[]> {
  const { where, params } = txConditions(householdId, filters);
  const result = await client.query<FinanceCategoryRowDto>(
    `with kt as (${kindedTx(where)})
     select kt.category_id as "categoryId",
            coalesce(cat.name, 'Sin categorizar') as "name",
            cat.parent_id as "parentId",
            sum(kt.amount_cents)::text as "totalCents",
            -- Number es correcto aquí: cuenta de filas, no dinero.
            count(*)::int as "count"
       from kt
       left join app.finance_categories cat on cat.household_id = $1 and cat.id = kt.category_id
      group by kt.category_id, cat.name, cat.parent_id
      order by sum(kt.amount_cents) asc`,
    params,
  );
  return result.rows;
}

export interface FinanceProviderRowDto { provider: string; providerDisplay: string; totalCents: string; count: number }

export async function readFinanceProviders(
  client: PoolClient,
  householdId: string,
  filters: FinanceReadFilters,
  limit = 10,
): Promise<FinanceProviderRowDto[]> {
  const { where, params } = txConditions(householdId, filters);
  const result = await client.query<FinanceProviderRowDto>(
    // Se agrupa por `coalesce(provider_norm, provider)`: hay movimientos con
    // proveedor y sin normalizar, y agrupar solo por provider_norm los colapsaría
    // TODOS en una fila NULL rotulada con un `min(provider)` arbitrario. El alias
    // entra por `left join lateral … limit 1`: el UNIQUE (household_id,
    // provider_norm) de 0036_finance.sql garantiza como mucho un alias por
    // proveedor, pero la lateral mantiene la misma disciplina defensiva que
    // `ALIAS_DISPLAY` (limit 1, nunca un join llano) en vez de dar por hecho
    // hoy lo que el esquema declara.
    `with kt as (${kindedTx(where)})
     select coalesce(kt.provider_norm, kt.provider) as "provider",
            coalesce(max(alias.display), min(kt.provider)) as "providerDisplay",
            sum(kt.amount_cents)::text as "totalCents",
            -- Number es correcto aquí: cuenta de filas, no dinero.
            count(*)::int as "count"
       from kt
       left join lateral (
              select a.display
                from app.finance_provider_aliases a
               where a.household_id = $1 and a.provider_norm = kt.provider_norm
               limit 1
            ) alias on true
      where kt.kind = 'gasto' and kt.provider is not null and kt.provider <> ''
      group by coalesce(kt.provider_norm, kt.provider)
     having sum(kt.amount_cents) < 0
      order by sum(kt.amount_cents) asc
      limit ${Math.max(1, Math.min(50, Math.trunc(limit)))}`,
    params,
  );
  return result.rows;
}

export interface FinanceEventSummaryDto { id: string; name: string; incomeCents: string; expenseCents: string; netCents: string; txCount: number }
export interface FinanceEventDetailDto extends FinanceEventSummaryDto { categories: FinanceCategoryRowDto[] }

export async function readFinanceEventsSummary(
  client: PoolClient,
  householdId: string,
  filters: FinanceReadFilters,
): Promise<FinanceEventSummaryDto[]> {
  const { where, params } = txConditions(householdId, filters);
  const result = await client.query<Omit<FinanceEventSummaryDto, "netCents">>(
    `with kt as (${kindedTx(where)})
     select event.id, event.name,
            coalesce(sum(kt.amount_cents) filter (where kt.kind = 'ingreso'), 0)::text as "incomeCents",
            coalesce(sum(kt.amount_cents) filter (where kt.kind = 'gasto'), 0)::text as "expenseCents",
            -- Number es correcto aquí: cuenta de movimientos, no dinero.
            count(kt.id)::int as "txCount"
       from app.finance_events event
       left join app.finance_transaction_events te
         on te.household_id = event.household_id and te.event_id = event.id
       left join kt on kt.id = te.transaction_id
      where event.household_id = $1
      group by event.id, event.name
      order by lower(event.name)`,
    params,
  );
  return result.rows.map((row) => ({
    ...row,
    netCents: (BigInt(row.incomeCents) + BigInt(row.expenseCents)).toString(),
  }));
}

export async function readFinanceEventDetail(
  client: PoolClient,
  householdId: string,
  eventId: string,
  filters: FinanceReadFilters,
): Promise<FinanceEventDetailDto | null> {
  const event = await client.query<{ id: string; name: string }>(
    `select id, name from app.finance_events where household_id = $1 and id = $2`,
    [householdId, eventId],
  );
  if (event.rows.length === 0) return null;
  // Cabecera y desglose miran EXACTAMENTE la misma población: si la petición
  // trae `?ev=` de otro evento, con `filters` a secas el resumen quedaría
  // restringido a ese otro evento y la cabecera saldría a cero contra un
  // desglose lleno.
  const scoped = { ...filters, eventId };
  const summary = (await readFinanceEventsSummary(client, householdId, scoped))
    .find((row) => row.id === eventId) ?? {
      id: eventId, name: event.rows[0]!.name, incomeCents: "0", expenseCents: "0", netCents: "0", txCount: 0,
    };
  const categories = await readFinanceBreakdown(client, householdId, scoped);
  return { ...summary, categories };
}

// ── Analítica y pivot (canónicas del doc de interfaces; la fase 6 las consume) ─

export interface AnalyticsMonthTotals { totalCents: string; recCents: string; extCents: string }
export interface AnalyticsRow { kind: "gasto" | "ingreso" | "inversion"; monthly: Record<string, AnalyticsMonthTotals> }

/** Meses de calendario del rango, ambos incluidos: las columnas del pivot. */
export function monthsInRange(from: string, to: string): string[] {
  const [fromYear, fromMonth] = splitIso(from);
  const [toYear, toMonth] = splitIso(to);
  const months: string[] = [];
  for (let index = fromYear * 12 + (fromMonth - 1); index <= toYear * 12 + (toMonth - 1); index += 1) {
    months.push(`${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`);
  }
  return months;
}

/**
 * Filas mensuales por naturaleza para la pantalla de Analítica (fase 6).
 * `ingreso`/`gasto` salen de `kt` (sin patas de transferencia); `inversion` son
 * las entradas en cuentas `kind = 'inversion'`, que el dominio identifica por
 * el kind de la cuenta y NUNCA por el banco.
 */
export async function readFinanceAnalytics(
  client: PoolClient,
  householdId: string,
  filters: FinanceReadFilters,
): Promise<{ rows: AnalyticsRow[] }> {
  const { where, params } = txConditions(householdId, filters);
  const flow = await client.query<{ kind: string; month: string; totalCents: string; recCents: string; extCents: string }>(
    `with kt as (${kindedTx(where)})
     select kt.kind,
            to_char(kt.op_date, 'YYYY-MM') as "month",
            sum(kt.amount_cents)::text as "totalCents",
            coalesce(sum(kt.amount_cents) filter (where kt.recurrence = 'recurrente'), 0)::text as "recCents",
            coalesce(sum(kt.amount_cents) filter (where kt.recurrence = 'extraordinario'), 0)::text as "extCents"
       from kt
      group by kt.kind, 2
      order by 2`,
    params,
  );
  const invested = await client.query<{ month: string; totalCents: string; recCents: string; extCents: string }>(
    `select to_char(tx.op_date, 'YYYY-MM') as "month",
            sum(tx.amount_cents)::text as "totalCents",
            coalesce(sum(tx.amount_cents) filter (where tx.recurrence = 'recurrente'), 0)::text as "recCents",
            coalesce(sum(tx.amount_cents) filter (where tx.recurrence = 'extraordinario'), 0)::text as "extCents"
       from app.finance_transactions tx
       join app.finance_accounts account
         on account.household_id = tx.household_id and account.id = tx.account_id
      where ${where}
        and account.kind = 'inversion'
        and tx.amount_cents > 0
      group by 1
      order by 1`,
    params,
  );

  const empty = (): AnalyticsRow["monthly"] => ({});
  const byKind: Record<AnalyticsRow["kind"], AnalyticsRow["monthly"]> = {
    ingreso: empty(),
    gasto: empty(),
    inversion: empty(),
  };
  for (const row of flow.rows) {
    if (row.kind !== "ingreso" && row.kind !== "gasto") continue;
    byKind[row.kind][row.month] = { totalCents: row.totalCents, recCents: row.recCents, extCents: row.extCents };
  }
  for (const row of invested.rows) {
    byKind.inversion[row.month] = { totalCents: row.totalCents, recCents: row.recCents, extCents: row.extCents };
  }
  // Orden FIJO: la Analítica pinta siempre las tres bandas, aunque estén vacías.
  return { rows: [
    { kind: "ingreso", monthly: byKind.ingreso },
    { kind: "gasto", monthly: byKind.gasto },
    { kind: "inversion", monthly: byKind.inversion },
  ] };
}

export interface FinancePivotMovDto { id: string; date: string; cents: string }
export interface FinancePivotRowDto extends Omit<PivotSourceRow, "totalCents" | "movs"> {
  totalCents: string;
  movs: FinancePivotMovDto[];
}

/** `PivotSourceRow` (bigint, canónico de fase 2) → DTO de cable (céntimos-string). */
export function serializePivotRows(rows: readonly PivotSourceRow[]): FinancePivotRowDto[] {
  return rows.map((row) => ({
    ...row,
    totalCents: row.totalCents.toString(),
    movs: row.movs.map((mov) => ({ id: mov.id, date: mov.date, cents: mov.cents.toString() })),
  }));
}

/**
 * Filas fuente del pivot con la forma EXACTA de `PivotSourceRow` (fase 2), para
 * que `buildPivotTree(rows, dims, { monthsCount, dupEventIds })` las coma tal
 * cual. Una transacción con dos eventos produce DOS filas: es la duplicación
 * que `dupEventIds` gobierna después, no un error de la consulta.
 */
export async function readFinancePivot(
  client: PoolClient,
  householdId: string,
  filters: FinanceReadFilters,
): Promise<{ months: string[]; rows: PivotSourceRow[] }> {
  const { where, params } = txConditions(householdId, filters);
  const result = await client.query<{
    cat: string; sub: string | null; catId: string | null; nat: FinanceRecurrence;
    prov: string; concept: string; event: string | null; eventId: string | null;
    kind: PivotSourceRow["kind"]; month: string; totalCents: string; count: number;
    movs: { id: string; date: string; cents: string }[];
  }>(
    `select coalesce(parent.name, cat.name, 'Sin categorizar') as "cat",
            case when parent.id is null then null else cat.name end as "sub",
            tx.category_id as "catId",
            tx.recurrence::text as "nat",
            coalesce(${ALIAS_DISPLAY}, tx.provider, '(sin proveedor)') as "prov",
            tx.concept,
            event.name as "event",
            event.id as "eventId",
            case when account.kind = 'inversion' then 'inversion'
                 when cat.kind is not null then cat.kind::text
                 when tx.amount_cents > 0 then 'ingreso' else 'gasto' end as "kind",
            to_char(tx.op_date, 'YYYY-MM') as "month",
            sum(tx.amount_cents)::text as "totalCents",
            -- Number es correcto aquí: cuenta de movimientos, no dinero.
            count(*)::int as "count",
            json_agg(json_build_object(
              'id', tx.id, 'date', tx.op_date::text, 'cents', tx.amount_cents::text
            ) order by tx.op_date, tx.id) as "movs"
       from app.finance_transactions tx
       join app.finance_accounts account
         on account.household_id = tx.household_id and account.id = tx.account_id
       left join app.finance_categories cat
         on cat.household_id = tx.household_id and cat.id = tx.category_id
       left join app.finance_categories parent
         on parent.household_id = cat.household_id and parent.id = cat.parent_id
       left join app.finance_transaction_events te
         on te.household_id = tx.household_id and te.transaction_id = tx.id
       left join app.finance_events event
         on event.household_id = te.household_id and event.id = te.event_id
      where ${where}
      group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
      order by 10, 1, 2, 6`,
    params,
  );
  const rows: PivotSourceRow[] = result.rows.map((row) => ({
    ...row,
    totalCents: BigInt(row.totalCents),
    movs: row.movs.map((mov) => ({ id: mov.id, date: mov.date, cents: BigInt(mov.cents) })),
  }));
  return { months: monthsInRange(filters.from, filters.to), rows };
}
