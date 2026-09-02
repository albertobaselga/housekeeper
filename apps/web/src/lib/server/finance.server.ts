import type { Pool, PoolClient } from 'pg';
import { error, isHttpError, json } from '@sveltejs/kit';

import {
  AuthorizationError,
  CommandRejectedError,
  createLogger,
  errorCode,
  requireFinanceAdmin,
  withAuthorizedTransaction,
  readFinanceAccounts,
  readFinanceAnalytics,
  readFinanceBreakdown,
  readFinanceCategories,
  readFinanceEvents,
  readFinanceEventsSummary,
  readFinancePivot,
  readFinanceProviders,
  readFinanceSeries,
  readFinanceSummary,
  readFinanceTransactions,
  type FinanceAccountDto,
  type FinanceCategoryDto,
  type FinanceCategoryRowDto,
  type FinanceEventDto,
  type FinanceProviderRowDto,
  type FinanceReadFilters,
  type FinanceSeriesPointDto,
  type FinanceSummaryDto,
  type FinanceTransactionsPage,
  type FinanceTransactionsQuery
} from '@housekeeper/server';

import { belongsToHousehold } from '$lib/auth/membership';
import {
  isFinanceAccountKind,
  isFinanceCategoryKind,
  type AnaliticaCategory,
  type AnaliticaData,
  type AnaliticaEventSummary,
  type AnaliticaPivotRow,
  type AnaliticaSummary
} from '$lib/finance/analitica-data';
import type { AnalyticsRowLike } from '$lib/finance/chart-data';
import { DATE_PATTERN, isUuid, type FinanceFilters } from '$lib/finance/filters';
import { DATA_UNAVAILABLE_MESSAGE, DATA_UNAVAILABLE_STATUS, unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';

const log = createLogger('web:finance');

/**
 * Lecturas del módulo Finanzas bajo RLS y doble cerrojo (§4): la transacción
 * autorizada fija el contexto y `requireFinanceAdmin` corta en seco a quien no
 * es admin-con-concesión (cinturón además de la RLS, que ya devuelve cero
 * filas). Devuelve null cuando no hay pool (demo) o la membresía no autoriza:
 * la página cae entonces a la fixture, o al 403 del guard de ruta si quien
 * llega no tiene la capacidad `finance.access`.
 *
 * `requireFinanceAdmin` (fase 1) rechaza con `CommandRejectedError`, no con
 * `AuthorizationError`: se capturan las dos junto al `catch`, porque para
 * quien mira la pantalla «no eres family_admin» y «Finanzas no está
 * concedido» son el mismo estado de «sin acceso» (Ruling R2).
 */

/**
 * Ventana de la serie EN MESES según la granularidad: `readFinanceSeries`
 * recorta siempre por meses, así que con `g=quarter` una ventana de 12 meses
 * daría 4 cubos y con `g=year`, uno solo. 12 cubos en cada granularidad son 12
 * meses, 36 meses o 120 meses; el rótulo de la tarjeta acompaña (Task 12).
 */
const SERIES_MONTHS: Record<FinanceFilters['granularity'], number> = { month: 12, quarter: 36, year: 120 };

const toReadFilters = (filters: FinanceFilters): FinanceReadFilters => ({
  from: filters.from,
  to: filters.to,
  accountIds: filters.accountIds,
  eventId: filters.eventId,
  excludeEventIds: []
});

export interface FinanceDashboardData {
  householdId: string;
  filters: FinanceFilters;
  summary: FinanceSummaryDto;
  series: FinanceSeriesPointDto[];
  breakdown: FinanceCategoryRowDto[];
  providers: FinanceProviderRowDto[];
  accounts: FinanceAccountDto[];
  categories: FinanceCategoryDto[];
}

export async function loadFinanceDashboard(
  user: { id: string },
  householdId: string,
  filters: FinanceFilters,
  pool: Pool | null = getDatabasePool()
): Promise<FinanceDashboardData | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      await requireFinanceAdmin(client, membership);
      const read = toReadFilters(filters);
      const summary = await readFinanceSummary(client, householdId, read);
      const series = await readFinanceSeries(client, householdId, read, filters.granularity, SERIES_MONTHS[filters.granularity]);
      const breakdown = await readFinanceBreakdown(client, householdId, read);
      const providers = await readFinanceProviders(client, householdId, read, 10);
      const accounts = await readFinanceAccounts(client, householdId);
      const categories = await readFinanceCategories(client, householdId);
      return { householdId, filters, summary, series, breakdown, providers, accounts, categories };
    });
  } catch (cause) {
    if (cause instanceof AuthorizationError || cause instanceof CommandRejectedError) return null;
    return unreadable(log, 'finance dashboard', cause);
  }
}

export interface FinanceMovimientosQuery {
  q: string | null;
  categoryId: string | null;
  recurrence: 'recurrente' | 'extraordinario' | null;
  limit: number;
  offset: number;
}

export interface FinanceMovimientosData {
  householdId: string;
  filters: FinanceFilters;
  page: FinanceTransactionsPage;
  accounts: FinanceAccountDto[];
  categories: FinanceCategoryDto[];
  events: FinanceEventDto[];
}

export async function loadFinanceMovimientos(
  user: { id: string },
  householdId: string,
  filters: FinanceFilters,
  query: FinanceMovimientosQuery,
  pool: Pool | null = getDatabasePool()
): Promise<FinanceMovimientosData | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      await requireFinanceAdmin(client, membership);
      const page = await readFinanceTransactions(client, householdId, {
        ...toReadFilters(filters),
        q: query.q,
        categoryId: query.categoryId,
        recurrence: query.recurrence,
        status: null,
        ids: [],
        groupIds: [],
        limit: query.limit,
        offset: query.offset
      });
      const accounts = await readFinanceAccounts(client, householdId);
      const categories = await readFinanceCategories(client, householdId);
      const events = await readFinanceEvents(client, householdId);
      return { householdId, filters, page, accounts, categories, events };
    });
  } catch (cause) {
    if (cause instanceof AuthorizationError || cause instanceof CommandRejectedError) return null;
    return unreadable(log, 'finance movimientos', cause);
  }
}

export interface FinanceRevisionRow {
  id: string;
  opDate: string;
  accountName: string;
  concept: string;
  provider: string | null;
  providerDisplay: string | null;
  amountCents: string;
  status: string;
  categoryId: string | null;
  recurrence: 'recurrente' | 'extraordinario' | null;
  transferGroupId: string | null;
}

export interface FinanceRevisionData {
  from: string;
  to: string;
  rows: FinanceRevisionRow[];
  categories: FinanceCategoryDto[];
}

/** Pendientes y sugerencias del rango: la bandeja de Revisión (spec §8). */
export async function loadFinanceRevision(
  user: { id: string },
  householdId: string,
  range: { from: string; to: string },
  pool: Pool | null = getDatabasePool()
): Promise<FinanceRevisionData | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      await requireFinanceAdmin(client, membership);
      const rows = await client.query<FinanceRevisionRow>(
        `select tx.id, tx.op_date::text as "opDate", acc.name as "accountName", tx.concept,
                tx.provider, alias.display as "providerDisplay", tx.amount_cents::text as "amountCents",
                tx.status::text as status, tx.category_id as "categoryId", tx.recurrence::text as recurrence,
                tx.transfer_group_id as "transferGroupId"
           from app.finance_transactions as tx
           join app.finance_accounts as acc
             on acc.household_id = tx.household_id and acc.id = tx.account_id
           left join app.finance_provider_aliases as alias
             on alias.household_id = tx.household_id and alias.provider_norm = tx.provider_norm
          where tx.household_id = $1 and tx.status <> 'confirmada'
            and tx.op_date between $2 and $3
          order by tx.op_date desc, tx.id desc`,
        [householdId, range.from, range.to]
      );
      const categories = await readFinanceCategories(client, householdId);
      return { from: range.from, to: range.to, rows: rows.rows, categories };
    });
  } catch (cause) {
    // Igual que el dashboard y Movimientos (Ruling R2): «no eres family_admin»
    // (CommandRejectedError) y «sin membresía viva» (AuthorizationError) son el
    // mismo «sin acceso» para quien mira la pantalla — la ruta ya lo blindó con
    // `finance.access` en el layout del hogar, esto es el cinturón.
    if (cause instanceof AuthorizationError || cause instanceof CommandRejectedError) return null;
    return unreadable(log, 'finance revision', cause);
  }
}

// ── Guard y parseo de los GET /api/v1/finance/* (§7, Task 8) ────────────────
//
// `isUuid`/`DATE_PATTERN` vienen de $lib/finance/filters (Ruling R12): ese
// regex y esa comprobación ya existían para las páginas de servidor y no se
// copian aquí. `g`, `rec` y `status` se validan con guardas de tipo sobre
// listas constantes, nunca con `as` (Ruling R7).

const TX_STATUSES = ['pendiente', 'sugerida_regla', 'sugerida_agente', 'confirmada'] as const;

function isTxStatus(value: string): value is (typeof TX_STATUSES)[number] {
  return (TX_STATUSES as readonly string[]).includes(value);
}

const RECURRENCES = ['recurrente', 'extraordinario'] as const;

function isRecurrence(value: string): value is (typeof RECURRENCES)[number] {
  return (RECURRENCES as readonly string[]).includes(value);
}

/**
 * Lista de uuids separados por comas, validando cada uno (Ruling R7: sin `as`,
 * con guarda). Única definición (antes se reimplementaba a mano — split, trim,
 * filter, un `for` con `isUuid` — en el endpoint de pivot para `dupev`):
 * `pivot/+server.ts` la importa de aquí en vez de copiarla.
 */
export function csvUuids(value: string | null, name: string): string[] {
  if (!value) return [];
  const ids = value
    .split(',')
    .map((piece) => piece.trim())
    .filter(Boolean);
  for (const id of ids) if (!isUuid(id)) error(400, `Parámetro ${name} inválido`);
  return ids;
}

/**
 * Única validación de entero de los GET /api/v1/finance/* (m1): antes
 * `transactions` clampeaba en silencio (este `intParam`) mientras `providers`
 * (`limit`) y `series` (`months`) reimplementaban a mano una validación que
 * respondía 400 — dos políticas incompatibles para el mismo tipo de
 * parámetro. `onOutOfRange` las unifica sin cambiar el comportamiento visible
 * de ninguna: `'clamp'` (por defecto, lo que ya hacía `transactions` con
 * `limit`/`offset`) o `'reject'` (400, lo que ya hacían `providers`/`series`).
 */
export function intParam(
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max: number,
  options: { onOutOfRange: 'clamp' | 'reject' } = { onOutOfRange: 'clamp' }
): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) error(400, `Parámetro ${name} inválido`);
  if (options.onOutOfRange === 'reject' && (value < min || value > max)) {
    error(400, `Parámetro ${name} inválido`);
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * Guard común de los GET /api/v1/finance/* (§7): el hook rellena locals.user
 * también en /api; lo que salta para /api es el guard de hogar/capacidad, así
 * que sesión, hogar y membresía se comprueban aquí, explícitos y en este
 * orden. Sin base de datos no hay lectura REST que servir: 503 honesto, nunca
 * una maqueta (regla de data-source.server.ts). El pool entra por parámetro
 * —mismo patrón que los loaders— para que el test del 503 pueda pasar `null`
 * explícito en vez de confiar en que DATABASE_URL esté vacía en el proceso de
 * vitest.
 */
export function requireFinanceRequest(
  locals: App.Locals,
  url: URL,
  pool: Pool | null = getDatabasePool()
): { user: { id: string }; householdId: string; pool: Pool } {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  const householdId = url.searchParams.get('household') ?? '';
  if (!isUuid(householdId)) error(400, 'Falta el hogar (household)');
  if (!belongsToHousehold(locals.user, householdId)) error(404, 'Hogar no encontrado');
  if (!pool) error(DATA_UNAVAILABLE_STATUS, DATA_UNAVAILABLE_MESSAGE);
  return { user: { id: locals.user.id }, householdId, pool };
}

export function parseReadFilters(url: URL): FinanceReadFilters {
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) error(400, 'Rango de fechas inválido (from/to)');
  const eventId = url.searchParams.get('ev');
  if (eventId && !isUuid(eventId)) error(400, 'Parámetro ev inválido');
  return {
    from,
    to,
    accountIds: csvUuids(url.searchParams.get('acc'), 'acc'),
    eventId: eventId || null,
    excludeEventIds: csvUuids(url.searchParams.get('exev'), 'exev')
  };
}

/**
 * ¿Trae la petición selección por `ids` o por `group_ids` (aunque vengan
 * vacíos)? Es el camino del panel de detalle (api.ts:99-102), que nunca manda
 * from/to. Única definición: antes `transactions/+server.ts` volvía a mirar
 * `url.searchParams.has(...)` por su cuenta para decidir la página vacía
 * canónica de R21, la misma regla que ya calculaba este módulo.
 */
export function hasIdsSelection(url: URL): boolean {
  return url.searchParams.has('ids') || url.searchParams.has('group_ids');
}

/**
 * `ids`/`group_ids` PRESENTES (aunque vengan vacíos) desactivan el rango:
 * es el camino del panel de detalle (api.ts:99-102), que nunca manda from/to.
 * Que la lista quede vacía tras el parseo es asunto del endpoint (Ruling
 * R21: «sin coincidencias», no «sin filtro»), no de este parseo compartido.
 */
export function parseTransactionsQuery(url: URL): FinanceTransactionsQuery {
  const idsSelection = hasIdsSelection(url);
  const ids = csvUuids(url.searchParams.get('ids'), 'ids');
  const groupIds = csvUuids(url.searchParams.get('group_ids'), 'group_ids');
  const filters = idsSelection
    ? { from: '1900-01-01', to: '2999-12-31', accountIds: [], eventId: null, excludeEventIds: [] }
    : parseReadFilters(url);
  const categoryId = url.searchParams.get('cat');
  if (categoryId && !isUuid(categoryId)) error(400, 'Parámetro cat inválido');
  const recurrenceParam = url.searchParams.get('rec');
  let recurrence: 'recurrente' | 'extraordinario' | null = null;
  if (recurrenceParam !== null) {
    if (!isRecurrence(recurrenceParam)) error(400, 'Parámetro rec inválido');
    recurrence = recurrenceParam;
  }
  const statusParam = url.searchParams.get('status');
  let status: string | null = null;
  if (statusParam !== null) {
    if (!isTxStatus(statusParam)) error(400, 'Parámetro status inválido');
    status = statusParam;
  }
  return {
    ...filters,
    q: url.searchParams.get('q') || null,
    categoryId: categoryId || null,
    recurrence,
    status,
    ids,
    groupIds,
    limit: intParam(url, 'limit', 100, 1, 500),
    offset: intParam(url, 'offset', 0, 0, 1_000_000)
  };
}

// ── Analítica (fase 6) ───────────────────────────────────────────────────────
// Mismo patrón que loadFinanceDashboard: lectura bajo RLS con el cliente
// autorizado y mapeo explícito de los DTO (céntimos como cadena) al contrato
// de cliente (céntimos bigint). `BigInt(v)` acepta cadena y bigint, así que el
// mapeo vale aunque alguna lectura ya devuelva bigint (es el caso de
// `readFinancePivot`, que ya entrega `PivotSourceRow[]` con bigint del
// dominio — fase 2).

function toAnaliticaSummary(dto: FinanceSummaryDto): AnaliticaSummary {
  return {
    incomeCents: BigInt(dto.incomeCents),
    expenseCents: BigInt(dto.expenseCents),
    recurringExpenseCents: BigInt(dto.recurringExpenseCents),
    extraordinaryExpenseCents: BigInt(dto.extraordinaryExpenseCents),
    unclassifiedExpenseCents: BigInt(dto.unclassifiedExpenseCents),
    savingsCents: BigInt(dto.savingsCents),
    netSavingsRate: dto.netSavingsRate,
    grossSavingsRate: dto.grossSavingsRate,
    investedCents: BigInt(dto.investedCents),
    investmentRate: dto.investmentRate,
    freeCashFlowCents: BigInt(dto.freeCashFlowCents),
    opsCashFlowCents: BigInt(dto.opsCashFlowCents),
    receivedContributionsCents: BigInt(dto.receivedContributionsCents),
    outgoingTransfersCents: BigInt(dto.outgoingTransfersCents),
    pendingCount: dto.pendingCount
  };
}

function toAnaliticaEvents(
  dtos: Awaited<ReturnType<typeof readFinanceEventsSummary>>
): AnaliticaEventSummary[] {
  return dtos.map((e) => ({
    id: e.id,
    name: e.name,
    txCount: e.txCount,
    netCents: BigInt(e.netCents),
    incomeCents: BigInt(e.incomeCents),
    expenseCents: BigInt(e.expenseCents)
  }));
}

function toAnaliticaCategories(
  dtos: Awaited<ReturnType<typeof readFinanceCategories>>
): AnaliticaCategory[] {
  return dtos.map((c) => {
    if (!isFinanceCategoryKind(c.kind)) throw new Error(`kind de categoría desconocido: ${c.kind}`);
    return { id: c.id, parentId: c.parentId, name: c.name, kind: c.kind };
  });
}

function toAnalyticsRows(
  rows: Awaited<ReturnType<typeof readFinanceAnalytics>>['rows']
): AnalyticsRowLike[] {
  return rows.map((r) => ({
    kind: r.kind,
    monthly: Object.fromEntries(
      Object.entries(r.monthly).map(([month, m]) => [
        month,
        { totalCents: BigInt(m.totalCents), recCents: BigInt(m.recCents), extCents: BigInt(m.extCents) }
      ])
    )
  }));
}

function toAnaliticaPivotRows(
  rows: Awaited<ReturnType<typeof readFinancePivot>>['rows']
): AnaliticaPivotRow[] {
  // `PivotSourceRow` (dominio, fase 2) ya trae bigint y los mismos nombres de
  // campo que `AnaliticaPivotRow`: el mapeo es de FORMA (movs a array
  // mutable), no de tipo. `BigInt(...)` es un no-op sobre un bigint y protege
  // si alguna lectura futura devolviera cadena.
  return rows.map((r) => ({
    cat: r.cat,
    sub: r.sub,
    catId: r.catId,
    nat: r.nat,
    prov: r.prov,
    concept: r.concept,
    event: r.event,
    eventId: r.eventId,
    kind: r.kind,
    month: r.month,
    totalCents: BigInt(r.totalCents),
    count: r.count,
    movs: r.movs.map((m) => ({ id: m.id, date: m.date, cents: BigInt(m.cents) }))
  }));
}

/**
 * Lectura de Analítica bajo RLS: mismo patrón que `loadFinanceDashboard`
 * (doble cerrojo, `catch` compartido). `excludeEventIds` ya llega filtrado a
 * UUIDs válidos desde la ruta (Ruling R24 del coordinador): aquí solo se
 * inyecta en los filtros de lectura, junto a `toReadFilters` (que por defecto
 * lo fija a `[]`).
 */
export async function loadFinanceAnalitica(
  user: { id: string },
  householdId: string,
  filters: FinanceFilters,
  excludeEventIds: string[],
  pool: Pool | null = getDatabasePool()
): Promise<Omit<AnaliticaData, 'filters'> | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      await requireFinanceAdmin(client, membership);
      const read: FinanceReadFilters = { ...toReadFilters(filters), excludeEventIds };
      // La tabla de partidas NUNCA se autoexcluye: es donde el usuario elige QUÉ
      // excluir, así que sus importes deben verse siempre completos (referencia
      // dorada: home-finance/backend/app/reports.py:616-623, `events_summary`
      // no toma `exclude_event_ids`; solo lo toman `range_summary`/`series`/
      // `analytics`/`pivot_rows`). Con `read` aquí, la partida excluida se
      // mostraría con todo a 0,00 € y los subtotales «No seleccionado»/«Total»
      // quedarían muertos.
      const readEvents: FinanceReadFilters = toReadFilters(filters);
      // F6-S2: las cinco lecturas comparten UN `PoolClient` dentro de la misma
      // transacción autorizada. `Promise.all` las solapaba sobre ese único
      // cliente y `pg` avisaba («Calling client.query() when the client is
      // already executing a query», error a secas desde pg@9): no hay
      // paralelismo real que ganar —un cliente serializa igualmente— así que
      // se secuencian.
      const summary = await readFinanceSummary(client, householdId, read);
      const analytics = await readFinanceAnalytics(client, householdId, read);
      const pivot = await readFinancePivot(client, householdId, read);
      const events = await readFinanceEventsSummary(client, householdId, readEvents);
      const categories = await readFinanceCategories(client, householdId);
      const accounts = await readFinanceAccounts(client, householdId);
      const cuentas = accounts.map((acc) => {
        if (!isFinanceAccountKind(acc.kind)) throw new Error(`kind de cuenta desconocido: ${acc.kind}`);
        return { id: acc.id, name: acc.name, kind: acc.kind };
      });
      return {
        from: filters.from,
        to: filters.to,
        months: pivot.months,
        summary: toAnaliticaSummary(summary),
        analyticsRows: toAnalyticsRows(analytics.rows),
        pivotRows: toAnaliticaPivotRows(pivot.rows),
        eventsSummary: toAnaliticaEvents(events),
        categories: toAnaliticaCategories(categories),
        accounts: cuentas,
        invAccounts: cuentas.filter((acc) => acc.kind === 'inversion').map((acc) => ({ id: acc.id, name: acc.name }))
      };
    });
  } catch (cause) {
    if (cause instanceof AuthorizationError || cause instanceof CommandRejectedError) return null;
    return unreadable(log, 'finance analitica', cause);
  }
}

/** Ejecuta una lectura autorizada y responde JSON sin caché. */
export async function financeRead<T>(
  locals: App.Locals,
  url: URL,
  reader: (client: PoolClient, householdId: string) => Promise<T>
): Promise<Response> {
  const { user, householdId, pool } = requireFinanceRequest(locals, url);
  try {
    const payload = await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      await requireFinanceAdmin(client, membership);
      return reader(client, householdId);
    });
    return json(payload, { headers: { 'cache-control': 'no-store' } });
  } catch (cause) {
    // Sin membresía o sin concesión: 404, indistinguible de inexistente (Ruling R2).
    if (cause instanceof AuthorizationError || cause instanceof CommandRejectedError) error(404, 'Hogar no encontrado');
    if (isHttpError(cause)) throw cause;
    log.error('finance api unavailable', { code: errorCode(cause) });
    error(DATA_UNAVAILABLE_STATUS, DATA_UNAVAILABLE_MESSAGE);
  }
}

// ── Eventos (Task 11) ────────────────────────────────────────────────────────

export interface FinanceEventSummaryRow {
  id: string;
  name: string;
  txCount: number;
  expenseCents: string;
  incomeCents: string;
  netCents: string;
  totalCount: number;
}

export interface FinanceEventosData {
  from: string;
  to: string;
  openId: string | null;
  summary: FinanceEventSummaryRow[];
  // `categoryId` (no lo traía el brief) es imprescindible como key de fila en
  // Svelte: `readFinanceBreakdown` agrupa por `(category_id, name, parent_id)`
  // (packages/server/src/finance/queries.ts:501), y el esquema solo garantiza
  // nombre único por `(household_id, parent_id, name)`
  // (packages/db/migrations/0036_finance.sql:134) — dos subcategorías con el
  // mismo nombre bajo padres distintos son legales, igual que "Sin
  // categorizar" conviviendo con una categoría real de ese nombre. Keyear por
  // `name` deja a Svelte 5 lanzar `each_key_duplicate` EN PRODUCCIÓN
  // (each.js:352-357 no lo guarda tras `if (DEV)`), tumbando el render de toda
  // la página al abrir un evento con esas categorías. [FASE 5, T11 · revisión
  // ronda 1, Important 1]
  detail: Array<{ categoryId: string | null; name: string; count: number; totalCents: string }> | null;
}

/**
 * Totales por evento del rango + desglose por categoría del evento abierto.
 *
 * [Ajuste sobre el brief] El brief de la Task 11 traía el resumen como SQL
 * propio de esta función, calcado a mano de `readFinanceEventsSummary`
 * (packages/server, ya existente y ya probada en
 * `queries.integration.test.ts`). La resolución del coordinador pide
 * exactamente lo contrario —reutilizarla, no duplicar su SQL en la ruta ni
 * aquí— así que este loader llama a esa lectura compartida en vez de
 * reimplementarla. Efecto colateral BUENO del cambio: la reimplementación del
 * brief sumaba TODOS los movimientos del evento (incluidas las categorías de
 * `kind = 'transferencia'`), mientras que `readFinanceEventsSummary` las
 * excluye —mismo criterio que el resto del módulo (dashboard, breakdown)—,
 * así que un evento con una transferencia enlazada ya no la cuenta como
 * ingreso o gasto. El desglose por categoría reutiliza igual `readFinanceBreakdown`
 * acotado a `eventId: openId` (mismo camino que sigue `readFinanceEventDetail`
 * por dentro, sin recalcular el resumen completo una segunda vez); su
 * `Sin categorizar` sustituye al `(sin categoría)` que el brief improvisaba,
 * por ser la etiqueta única ya establecida en esa lectura compartida.
 *
 * `totalCount` (movimientos enlazados al evento SIN el filtro de rango, para
 * el aviso de borrado del §T11 svelte) no lo cubre ninguna lectura existente:
 * es la única consulta propia de este loader, y cuenta filas de
 * `finance_transaction_events` sin más condición que el hogar.
 *
 * [Ajuste sobre el brief] El catch original del brief solo distinguía
 * `AuthorizationError`. `requireFinanceAdmin` (packages/server/commands/finance.ts)
 * rechaza con `CommandRejectedError` a quien no es `family_admin` o no tiene
 * Finanzas concedido — el mismo «sin acceso» que ya tratan como null
 * `loadFinanceDashboard`/`loadFinanceMovimientos`/`loadFinanceRevision`. Se
 * alinea aquí con esas tres: lo contrario habría hecho que un `family_member`
 * autenticado disparase un `log.error` de avería por cada visita a Eventos.
 */
export async function loadFinanceEventos(
  user: { id: string },
  householdId: string,
  range: { from: string; to: string },
  openId: string | null,
  pool: Pool | null = getDatabasePool()
): Promise<FinanceEventosData | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      await requireFinanceAdmin(client, membership);
      const { from, to } = range;
      const filters: FinanceReadFilters = { from, to, accountIds: [], eventId: null, excludeEventIds: [] };
      const rangeSummary = await readFinanceEventsSummary(client, householdId, filters);
      const totals = await client.query<{ id: string; totalCount: number }>(
        `select te.event_id as id, count(*)::int as "totalCount"
           from app.finance_transaction_events as te
          where te.household_id = $1
          group by te.event_id`,
        [householdId]
      );
      const totalById = new Map(totals.rows.map((row) => [row.id, row.totalCount]));
      const summary = rangeSummary.map((row) => ({ ...row, totalCount: totalById.get(row.id) ?? 0 }));
      const detail = openId ? await readFinanceBreakdown(client, householdId, { ...filters, eventId: openId }) : null;
      return { from, to, openId, summary, detail };
    });
  } catch (cause) {
    if (cause instanceof AuthorizationError || cause instanceof CommandRejectedError) return null;
    return unreadable(log, 'finance eventos', cause);
  }
}

// ── Importar (Task 12) ───────────────────────────────────────────────────────

export interface FinanceImportBatchRow {
  id: string;
  filename: string;
  bank: string;
  importedAt: string;
  newCount: number;
  dupCount: number;
}

export interface FinanceImportarData {
  batches: FinanceImportBatchRow[];
}

/**
 * Historial de importaciones del hogar, lo más reciente primero.
 *
 * [Ajuste sobre el brief] El brief solo capturaba `AuthorizationError` en el
 * catch. Las cuatro lecturas hermanas de este mismo fichero (dashboard,
 * movimientos, revisión, eventos) capturan también `CommandRejectedError`
 * —lo que lanza `requireFinanceAdmin` cuando quien mira no es
 * `family_admin` o no tiene Finanzas concedido (Ruling R2)—, así que se
 * alinea aquí con esas cuatro: lo contrario habría dejado que un
 * `family_member` autenticado sin concesión disparase un `log.error` de
 * avería en vez de la fixture/página vacía, por cada visita a Importar.
 */
export async function loadFinanceImportar(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<FinanceImportarData | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      await requireFinanceAdmin(client, membership);
      const result = await client.query<FinanceImportBatchRow>(
        `select id, filename, bank, imported_at::text as "importedAt",
                new_count as "newCount", dup_count as "dupCount"
           from app.finance_import_batches
          where household_id = $1
          order by imported_at desc`,
        [householdId]
      );
      return { batches: result.rows };
    });
  } catch (cause) {
    if (cause instanceof AuthorizationError || cause instanceof CommandRejectedError) return null;
    return unreadable(log, 'finance importar', cause);
  }
}
