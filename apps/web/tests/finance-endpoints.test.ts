import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseReadFilters, parseTransactionsQuery, requireFinanceRequest } from '../src/lib/server/finance.server';

// Pool inyectado: el guard no debe depender de si DATABASE_URL está puesta en
// el proceso de vitest. `FAKE_POOL` solo tiene que existir; nunca se usa.
const FAKE_POOL = {} as Pool;
const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const USER = {
  id: 'u1', name: 'Alberto', initials: 'A', email: 'a@casaclara.demo',
  memberships: [{ householdId: HOUSEHOLD, membershipId: 'm1', role: 'family_admin' as const }]
};
const urlOf = (query: string): URL => new URL(`https://casa.local/api/v1/finance/summary?${query}`);

function statusOf(run: () => unknown): number | null {
  try { run(); return null; } catch (cause) { return (cause as { status?: number }).status ?? null; }
}

describe('guard de los endpoints GET /api/v1/finance/* (el hook no cubre /api)', () => {
  it('sin sesión: 401', () => {
    expect(statusOf(() => requireFinanceRequest({ user: null } as unknown as App.Locals, urlOf(`household=${HOUSEHOLD}`), FAKE_POOL))).toBe(401);
  });
  it('household ausente o malformado: 400', () => {
    expect(statusOf(() => requireFinanceRequest({ user: USER } as unknown as App.Locals, urlOf(''), FAKE_POOL))).toBe(400);
    expect(statusOf(() => requireFinanceRequest({ user: USER } as unknown as App.Locals, urlOf('household=patata'), FAKE_POOL))).toBe(400);
  });
  it('hogar ajeno: 404, indistinguible de inexistente', () => {
    expect(statusOf(() => requireFinanceRequest({ user: USER } as unknown as App.Locals, urlOf('household=20000000-0000-4000-8000-000000000001'), FAKE_POOL))).toBe(404);
  });
  it('con sesión y membresía pero sin base de datos: 503 honesto', () => {
    expect(statusOf(() => requireFinanceRequest({ user: USER } as unknown as App.Locals, urlOf(`household=${HOUSEHOLD}`), null))).toBe(503);
  });
  it('con sesión, membresía y pool: pasa y devuelve el hogar', () => {
    const request = requireFinanceRequest({ user: USER } as unknown as App.Locals, urlOf(`household=${HOUSEHOLD}`), FAKE_POOL);
    expect(request.householdId).toBe(HOUSEHOLD);
    expect(request.user.id).toBe('u1');
  });
});

describe('parseo de filtros de lectura', () => {
  it('fechas malformadas: 400; válidas: pasan con acc/ev/exev', () => {
    expect(statusOf(() => parseReadFilters(urlOf('from=ayer&to=2026-01-31')))).toBe(400);
    const filters = parseReadFilters(urlOf(`from=2026-01-01&to=2026-01-31&acc=${HOUSEHOLD}&ev=${HOUSEHOLD}`));
    expect(filters.accountIds).toEqual([HOUSEHOLD]);
    expect(filters.eventId).toBe(HOUSEHOLD);
  });
  it('uuids malformados en acc/ids: 400', () => {
    expect(statusOf(() => parseReadFilters(urlOf('from=2026-01-01&to=2026-01-31&acc=uno,dos')))).toBe(400);
    expect(statusOf(() => parseTransactionsQuery(urlOf('ids=nope')))).toBe(400);
  });
  it('transactions: por ids ignora el rango; limit con tope y offset saneados', () => {
    const byIds = parseTransactionsQuery(urlOf(`ids=${HOUSEHOLD}`));
    expect(byIds.ids).toEqual([HOUSEHOLD]);
    const paged = parseTransactionsQuery(urlOf('from=2026-01-01&to=2026-01-31&limit=9999&offset=-3&rec=recurrente&status=confirmada'));
    expect(paged.limit).toBe(500);
    expect(paged.offset).toBe(0);
    expect(paged.recurrence).toBe('recurrente');
    expect(statusOf(() => parseTransactionsQuery(urlOf('from=2026-01-01&to=2026-01-31&status=inventado')))).toBe(400);
  });
  it('ids presente pero vacío (R21): no exige from/to y el array sale vacío para que decida el endpoint', () => {
    const query = parseTransactionsQuery(urlOf('ids='));
    expect(query.ids).toEqual([]);
    expect(query.groupIds).toEqual([]);
  });
});

/**
 * Los nueve `+server.ts` importados de verdad (patrón de
 * apps/web/tests/ics-feed.integration.test.ts), con `$lib/server/db.server`
 * mockeado a pool `null`: cubre 401/400/404 (que el guard o el parseo de cada
 * ruta resuelven ANTES de tocar la base) y el 503 honesto de quien sí llega al
 * cerrojo de `financeRead` sin pool (Ruling R14).
 */
describe('endpoints GET /api/v1/finance/*: guard y parseo por ruta (pool null → 503)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('$lib/server/db.server', () => ({ getDatabasePool: () => null }));
  });

  const noUser = { locals: { user: null }, url: urlOf(`household=${HOUSEHOLD}`), params: {} };
  const withUser = (query: string, params: Record<string, string> = {}): {
    locals: { user: typeof USER };
    url: URL;
    params: Record<string, string>;
  } => ({
    locals: { user: USER },
    url: new URL(`https://casa.local/api/v1/finance/x?household=${HOUSEHOLD}&${query}`),
    params
  });

  async function statusOfResponse(run: () => Promise<Response>): Promise<number> {
    try {
      const response = await run();
      return response.status;
    } catch (cause) {
      return (cause as { status?: number }).status ?? 0;
    }
  }

  type AnyGet = (event: unknown) => Promise<Response>;

  it('sin usuario: 401 (summary y transactions)', async () => {
    const { GET: summaryGet } = await import('../src/routes/api/v1/finance/summary/+server');
    const { GET: transactionsGet } = await import('../src/routes/api/v1/finance/transactions/+server');
    expect(await statusOfResponse(() => (summaryGet as AnyGet)(noUser))).toBe(401);
    expect(await statusOfResponse(() => (transactionsGet as AnyGet)(noUser))).toBe(401);
  });

  it('series: g inválida → 400 (antes de tocar financeRead)', async () => {
    const { GET: seriesGet } = await import('../src/routes/api/v1/finance/series/+server');
    const request = withUser('from=2026-01-01&to=2026-01-31&g=semana');
    expect(await statusOfResponse(() => (seriesGet as AnyGet)(request))).toBe(400);
  });

  it('pivot: dupev con id no UUID → 400', async () => {
    const { GET: pivotGet } = await import('../src/routes/api/v1/finance/pivot/+server');
    const request = withUser('from=2026-01-01&to=2026-01-31&dupev=no-es-un-uuid');
    expect(await statusOfResponse(() => (pivotGet as AnyGet)(request))).toBe(400);
  });

  it('providers: limit fuera de rango → 400', async () => {
    const { GET: providersGet } = await import('../src/routes/api/v1/finance/providers/+server');
    const request = withUser('from=2026-01-01&to=2026-01-31&limit=999');
    expect(await statusOfResponse(() => (providersGet as AnyGet)(request))).toBe(400);
  });

  it('events/[id]: id no UUID → 404', async () => {
    const { GET: eventDetailGet } = await import('../src/routes/api/v1/finance/events/[id]/+server');
    const request = withUser('from=2026-01-01&to=2026-01-31', { id: 'no-es-un-uuid' });
    expect(await statusOfResponse(() => (eventDetailGet as AnyGet)(request))).toBe(404);
  });

  it('sin pool: breakdown, analytics y events-summary devuelven 503 honesto', async () => {
    const { GET: breakdownGet } = await import('../src/routes/api/v1/finance/breakdown/+server');
    const { GET: analyticsGet } = await import('../src/routes/api/v1/finance/analytics/+server');
    const { GET: eventsSummaryGet } = await import('../src/routes/api/v1/finance/events-summary/+server');
    const request = withUser('from=2026-01-01&to=2026-01-31');
    expect(await statusOfResponse(() => (breakdownGet as AnyGet)(request))).toBe(503);
    expect(await statusOfResponse(() => (analyticsGet as AnyGet)(request))).toBe(503);
    expect(await statusOfResponse(() => (eventsSummaryGet as AnyGet)(request))).toBe(503);
  });
});

/**
 * R21 hasta el final: con un pool y un cerrojo de autorización simulados (sin
 * Postgres real), `transactions` con `ids=` presente pero vacío responde 200
 * con la página vacía canónica y SIN llamar a `readFinanceTransactions`.
 */
describe('transactions: R21 (ids/group_ids presentes pero vacíos)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('$lib/server/db.server', () => ({ getDatabasePool: () => ({}) }));
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
        readFinanceTransactions: vi.fn(async () => {
          throw new Error('no debería llamarse: R21 exige no tocar finance_transactions');
        })
      };
    });
  });

  it('ids= vacío, sin from/to: 200 con la página vacía canónica', async () => {
    const { GET: transactionsGet } = await import('../src/routes/api/v1/finance/transactions/+server');
    const event = {
      locals: { user: USER },
      url: new URL(`https://casa.local/api/v1/finance/transactions?household=${HOUSEHOLD}&ids=`),
      params: {}
    };
    const response = await (transactionsGet as (e: unknown) => Promise<Response>)(event);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ total: 0, sumCents: '0', limit: 100, offset: 0, rows: [] });
  });
});
