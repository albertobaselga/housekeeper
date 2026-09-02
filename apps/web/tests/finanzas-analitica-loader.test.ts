import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FinanceFilters } from '../src/lib/finance/filters';

/**
 * Regresión del Issue #1 (Important) de la revisión ronda 0 de la Task 8:
 * `loadFinanceAnalitica` pasaba `excludeEventIds` también a
 * `readFinanceEventsSummary`, dejando la partida excluida con todo a 0,00 € y
 * matando los subtotales «No seleccionado»/«Total» — justo la tabla que sirve
 * para ELEGIR qué excluir no puede autoexcluirse (referencia dorada:
 * home-finance/backend/app/reports.py:616-623, `events_summary` sin
 * `exclude_event_ids`). Este test aísla el loader (sin Postgres real) y
 * verifica QUÉ objeto de filtros recibe cada lectura.
 */

// Pool inyectado (mismo patrón que finance-endpoints.test.ts): nunca se usa de
// verdad porque withAuthorizedTransaction está mockeado más abajo.
const FAKE_POOL = {} as Pool;
const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const USER = { id: 'u1' };
const EVENT_ID = 'fc000000-0000-4000-8000-000000000011';

const FILTERS: FinanceFilters = {
  from: '2026-01-01',
  to: '2026-01-31',
  granularity: 'month',
  accountIds: [],
  eventId: null
};

const SUMMARY_DTO = {
  incomeCents: '0', expenseCents: '0', recurringExpenseCents: '0', extraordinaryExpenseCents: '0',
  unclassifiedExpenseCents: '0', savingsCents: '0', netSavingsRate: null, grossSavingsRate: null,
  investedCents: '0', investmentRate: null, freeCashFlowCents: '0', opsCashFlowCents: '0',
  receivedContributionsCents: '0', outgoingTransfersCents: '0', pendingCount: 0, prev: null
};

// Firma explícita de 3 argumentos (cliente, householdId, filtros) en las
// cuatro lecturas que reciben filtros: sin ella, `vi.fn` infiere la aridad de
// la lambda (`() => …`) y `mock.calls[0][2]` deja de tipar en `pnpm check`.
type ReadFiltersArg = { excludeEventIds: string[] };
const readFinanceSummary = vi.fn(async (_client: unknown, _householdId: string, _filters: ReadFiltersArg) => SUMMARY_DTO);
const readFinanceAnalytics = vi.fn(async (_client: unknown, _householdId: string, _filters: ReadFiltersArg) => ({ rows: [] }));
const readFinancePivot = vi.fn(async (_client: unknown, _householdId: string, _filters: ReadFiltersArg) => ({ months: [], rows: [] }));
const readFinanceEventsSummary = vi.fn(async (_client: unknown, _householdId: string, _filters: ReadFiltersArg) => []);
const readFinanceCategories = vi.fn(async (_client: unknown, _householdId: string) => []);
const readFinanceAccounts = vi.fn(async (_client: unknown, _householdId: string) => []);

describe('loadFinanceAnalitica: la tabla de partidas no se autoexcluye', () => {
  beforeEach(() => {
    vi.resetModules();
    readFinanceSummary.mockClear();
    readFinanceAnalytics.mockClear();
    readFinancePivot.mockClear();
    readFinanceEventsSummary.mockClear();
    readFinanceCategories.mockClear();
    readFinanceAccounts.mockClear();
    vi.doMock('@housekeeper/server', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@housekeeper/server')>();
      return {
        ...actual,
        requireFinanceAdmin: async () => {},
        withAuthorizedTransaction: async (
          _pool: unknown,
          _principal: unknown,
          _householdId: string,
          operation: (client: unknown, membership: unknown) => Promise<unknown>
        ) => operation({}, { id: 'm1', householdId: HOUSEHOLD, role: 'family_admin', expiresAt: null }),
        readFinanceSummary,
        readFinanceAnalytics,
        readFinancePivot,
        readFinanceEventsSummary,
        readFinanceCategories,
        readFinanceAccounts
      };
    });
  });

  it('summary/analytics/pivot reciben excludeEventIds; events-summary SIEMPRE recibe []', async () => {
    const { loadFinanceAnalitica } = await import('../src/lib/server/finance.server');
    const result = await loadFinanceAnalitica(USER, HOUSEHOLD, FILTERS, [EVENT_ID], FAKE_POOL);
    expect(result).not.toBeNull();

    expect(readFinanceSummary.mock.calls[0]?.[2]).toMatchObject({ excludeEventIds: [EVENT_ID] });
    expect(readFinanceAnalytics.mock.calls[0]?.[2]).toMatchObject({ excludeEventIds: [EVENT_ID] });
    expect(readFinancePivot.mock.calls[0]?.[2]).toMatchObject({ excludeEventIds: [EVENT_ID] });
    expect(readFinanceEventsSummary.mock.calls[0]?.[2]).toMatchObject({ excludeEventIds: [] });
  });
});
