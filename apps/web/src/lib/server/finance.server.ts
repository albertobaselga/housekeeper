import type { Pool } from 'pg';

import {
  AuthorizationError,
  CommandRejectedError,
  createLogger,
  requireFinanceAdmin,
  withAuthorizedTransaction,
  readFinanceAccounts,
  readFinanceBreakdown,
  readFinanceCategories,
  readFinanceEvents,
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
  type FinanceTransactionsPage
} from '@housekeeper/server';

import type { FinanceFilters } from '$lib/finance/filters';
import { unreadable } from './data-source.server';
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
