import type { PoolClient } from "pg";

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
