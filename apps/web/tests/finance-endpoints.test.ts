import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatImportedAt,
  intParam,
  parseReadFilters,
  parseTransactionsQuery,
  requireFinanceRequest
} from '../src/lib/server/finance.server';

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

// Helpers compartidos por los describe de más abajo (guard pool-null, m11,
// R21, I2): un evento con sesión y household válidos sobre
// `/api/v1/finance/x`, y el status HTTP tanto si el handler responde como si
// lanza (los `+server.ts` propagan `error(...)` como excepción).
type AnyGet = (event: unknown) => Promise<Response>;

const withUser = (query: string, params: Record<string, string> = {}): {
  locals: { user: typeof USER };
  url: URL;
  params: Record<string, string>;
} => ({
  locals: { user: USER },
  url: new URL(`https://casa.local/api/v1/finance/x?household=${HOUSEHOLD}&${query}`),
  params
});

const anonRequest = (query: string, params: Record<string, string> = {}): {
  locals: { user: null };
  url: URL;
  params: Record<string, string>;
} => ({
  locals: { user: null },
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

describe('guard de los endpoints GET /api/v1/finance/* (el hook rellena locals.user también en /api; lo que falta es el guard de hogar/capacidad, Ruling R9)', () => {
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

/**
 * m1: antes `transactions` clampeaba `limit`/`offset` en silencio (este mismo
 * `intParam`) mientras `providers` y `series` reimplementaban a mano una
 * validación que respondía 400. Una política explícita por llamada
 * (`onOutOfRange`) unifica las dos sin cambiar el comportamiento visible de
 * ninguna: un caso por política.
 */
describe('intParam: una única validación de entero, con política explícita (m1)', () => {
  it("'clamp' (por defecto, lo que ya hacía transactions): fuera de rango se acerca al límite, no falla", () => {
    expect(intParam(urlOf('limit=9999'), 'limit', 100, 1, 500)).toBe(500);
    expect(intParam(urlOf('offset=-3'), 'offset', 0, 0, 1_000_000)).toBe(0);
  });

  it("'reject' (lo que ya hacían providers/series): fuera de rango es 400", () => {
    expect(statusOf(() => intParam(urlOf('limit=999'), 'limit', 10, 1, 50, { onOutOfRange: 'reject' }))).toBe(400);
    expect(intParam(urlOf('limit=30'), 'limit', 10, 1, 50, { onOutOfRange: 'reject' })).toBe(30);
  });

  it('ausente: siempre el fallback, en cualquier política; no entero: 400 en las dos', () => {
    expect(intParam(urlOf(''), 'limit', 10, 1, 50)).toBe(10);
    expect(intParam(urlOf(''), 'limit', 10, 1, 50, { onOutOfRange: 'reject' })).toBe(10);
    expect(statusOf(() => intParam(urlOf('limit=patata'), 'limit', 10, 1, 50))).toBe(400);
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

  it('sin usuario: 401 (summary y transactions)', async () => {
    const { GET: summaryGet } = await import('../src/routes/api/v1/finance/summary/+server');
    const { GET: transactionsGet } = await import('../src/routes/api/v1/finance/transactions/+server');
    expect(await statusOfResponse(() => (summaryGet as AnyGet)(noUser))).toBe(401);
    expect(await statusOfResponse(() => (transactionsGet as AnyGet)(noUser))).toBe(401);
  });

  // m11: `series`, `pivot` y `events/[id]` validaban sus parámetros propios
  // ANTES de `financeRead`, así que un anónimo recibía 400/404 (revelando que
  // el parámetro es lo que falla) donde los demás endpoints le dan 401. Con la
  // validación movida dentro del closure, `requireFinanceRequest` corta antes
  // de que el parámetro se mire siquiera: 401 en los tres, igual que summary.
  it('anónimo con su propio parámetro inválido: 401 igualmente (series/pivot/events, antes 400/404)', async () => {
    const { GET: seriesGet } = await import('../src/routes/api/v1/finance/series/+server');
    const { GET: pivotGet } = await import('../src/routes/api/v1/finance/pivot/+server');
    const { GET: eventDetailGet } = await import('../src/routes/api/v1/finance/events/[id]/+server');
    expect(await statusOfResponse(() => (seriesGet as AnyGet)(anonRequest('g=semana')))).toBe(401);
    expect(await statusOfResponse(() => (pivotGet as AnyGet)(anonRequest('dupev=no-es-un-uuid')))).toBe(401);
    expect(await statusOfResponse(() => (eventDetailGet as AnyGet)(anonRequest('', { id: 'no-es-un-uuid' })))).toBe(401);
  });

  // m11 (brief) solo mueve series/pivot/events[id]: providers queda tal cual,
  // validando `limit` antes de `financeRead` (mismo 400 de siempre).
  it('providers: limit fuera de rango → 400 (validación fuera del cerrojo, sin cambios de m11)', async () => {
    const { GET: providersGet } = await import('../src/routes/api/v1/finance/providers/+server');
    const request = withUser('from=2026-01-01&to=2026-01-31&limit=999');
    expect(await statusOfResponse(() => (providersGet as AnyGet)(request))).toBe(400);
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
 * m11: con sesión y hogar válidos (cerrojo de autorización simulado, sin
 * Postgres real: mismo patrón que R21), la validación propia de
 * series/pivot/events ya no se adelanta a `financeRead` — vive dentro del
 * closure, así que solo se ejecuta tras pasar el guard. El resultado visible
 * para quien SÍ tiene sesión y hogar no cambia: 400/400/404, igual que antes.
 */
describe('series/pivot/events: la validación propia vive dentro del cerrojo (m11)', () => {
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
        ) => operation({}, { id: 'm1', householdId: HOUSEHOLD, role: 'family_admin', expiresAt: null })
      };
    });
  });

  it('series: g inválida, con sesión y hogar válidos → 400 (ya no antes del cerrojo)', async () => {
    const { GET: seriesGet } = await import('../src/routes/api/v1/finance/series/+server');
    const request = withUser('from=2026-01-01&to=2026-01-31&g=semana');
    expect(await statusOfResponse(() => (seriesGet as AnyGet)(request))).toBe(400);
  });

  it('pivot: dupev con id no UUID, con sesión y hogar válidos → 400 (ya no antes del cerrojo)', async () => {
    const { GET: pivotGet } = await import('../src/routes/api/v1/finance/pivot/+server');
    const request = withUser('from=2026-01-01&to=2026-01-31&dupev=no-es-un-uuid');
    expect(await statusOfResponse(() => (pivotGet as AnyGet)(request))).toBe(400);
  });

  it('events/[id]: id no UUID, con sesión y hogar válidos → 404 «Evento no encontrado» (ya no antes del cerrojo)', async () => {
    const { GET: eventDetailGet } = await import('../src/routes/api/v1/finance/events/[id]/+server');
    const request = withUser('from=2026-01-01&to=2026-01-31', { id: 'no-es-un-uuid' });
    expect(await statusOfResponse(() => (eventDetailGet as AnyGet)(request))).toBe(404);
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

/**
 * I2: el cerrojo aplicativo (`requireFinanceAdmin` dentro de `financeRead` y
 * de los dos loaders) no tenía ninguna prueba de regresión: si alguien borra
 * `await requireFinanceAdmin(client, membership)` de cualquiera de los tres
 * sitios, la batería entera seguía en verde. R2/R22: `AuthorizationError` y
 * `CommandRejectedError` son EL MISMO estado de «sin acceso» — se traducen a
 * 404 «Hogar no encontrado» en la API (indistinguible de hogar inexistente) y
 * a `null` en los loaders (la página cae a la fixture o al 403 del guard de
 * ruta), nunca a un 500 ni a una fuga de por qué.
 */
describe('I2: requireFinanceAdmin es el cerrojo aplicativo, no una comprobación decorativa', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('$lib/server/db.server', () => ({ getDatabasePool: () => ({}) }));
  });

  async function statusAndBody(run: () => Promise<Response>): Promise<{ status: number; body: unknown }> {
    try {
      const response = await run();
      return { status: response.status, body: await response.json() };
    } catch (cause) {
      const failure = cause as { status?: number; body?: unknown };
      return { status: failure.status ?? 0, body: failure.body };
    }
  }

  it('CommandRejectedError en requireFinanceAdmin → 404 "Hogar no encontrado" sin revelar el motivo, y sin llamar a la lectura', async () => {
    vi.doMock('@housekeeper/server', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@housekeeper/server')>();
      return {
        ...actual,
        requireFinanceAdmin: async () => {
          throw new actual.CommandRejectedError('finance_not_granted', 'Tu cuenta no tiene Finanzas activado');
        },
        withAuthorizedTransaction: async (
          _pool: unknown,
          _principal: unknown,
          _householdId: string,
          operation: (client: unknown, membership: unknown) => Promise<unknown>
        ) => operation({}, { id: 'm1', householdId: HOUSEHOLD, role: 'family_admin', expiresAt: null }),
        readFinanceSummary: vi.fn(async () => {
          throw new Error('no debería llamarse: requireFinanceAdmin ya debía haber cortado');
        })
      };
    });
    const { GET: summaryGet } = await import('../src/routes/api/v1/finance/summary/+server');
    const event = { locals: { user: USER }, url: urlOf(`household=${HOUSEHOLD}`), params: {} };
    const { status, body } = await statusAndBody(() => (summaryGet as (e: unknown) => Promise<Response>)(event));
    expect(status).toBe(404);
    expect(body).toEqual({ message: 'Hogar no encontrado' });
    expect(JSON.stringify(body)).not.toMatch(/concesión|finanzas|permiso/i);
  });

  it('AuthorizationError en requireFinanceAdmin → los loaders devuelven null (no propagan, no llaman a la lectura ni al logger de avería)', async () => {
    const errorSpy = vi.fn();
    vi.doMock('@housekeeper/server', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@housekeeper/server')>();
      return {
        ...actual,
        createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: errorSpy }),
        requireFinanceAdmin: async () => {
          throw new actual.AuthorizationError('sin concesión viva');
        },
        withAuthorizedTransaction: async (
          _pool: unknown,
          _principal: unknown,
          _householdId: string,
          operation: (client: unknown, membership: unknown) => Promise<unknown>
        ) => operation({}, { id: 'm1', householdId: HOUSEHOLD, role: 'family_admin', expiresAt: null }),
        readFinanceSummary: vi.fn(async () => { throw new Error('no debería llamarse'); }),
        readFinanceTransactions: vi.fn(async () => { throw new Error('no debería llamarse'); })
      };
    });
    const { loadFinanceDashboard, loadFinanceMovimientos, loadFinanceAjustes, loadFinanceRevision } = await import(
      '../src/lib/server/finance.server'
    );
    const filters = { from: '2026-01-01', to: '2026-01-31', granularity: 'month' as const, accountIds: [], eventId: null };
    const dashboard = await loadFinanceDashboard({ id: 'u1' }, HOUSEHOLD, filters, FAKE_POOL);
    expect(dashboard).toBeNull();
    const movimientos = await loadFinanceMovimientos(
      { id: 'u1' }, HOUSEHOLD, filters,
      { q: null, categoryId: null, recurrence: null, limit: 100, offset: 0 },
      FAKE_POOL
    );
    expect(movimientos).toBeNull();
    const ajustes = await loadFinanceAjustes({ id: 'u1' }, HOUSEHOLD, FAKE_POOL);
    expect(ajustes).toBeNull();
    // N4: la bandeja de Revisión entra en el mismo contrato, con un rango
    // válido EXPLÍCITO (no uno derivado de la fecha de hoy, que haría depender
    // el caso del día en que se ejecute).
    const revision = await loadFinanceRevision(
      { id: 'u1' }, HOUSEHOLD, { from: '2026-01-01', to: '2026-01-31' }, FAKE_POOL
    );
    expect(revision).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('CommandRejectedError en requireFinanceAdmin → loadFinanceAjustes también devuelve null (desviación del brief, M7), sin llamar al logger de avería', async () => {
    const errorSpy = vi.fn();
    vi.doMock('@housekeeper/server', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@housekeeper/server')>();
      return {
        ...actual,
        createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: errorSpy }),
        requireFinanceAdmin: async () => {
          throw new actual.CommandRejectedError('finance_not_granted', 'Tu cuenta no tiene Finanzas activado');
        },
        withAuthorizedTransaction: async (
          _pool: unknown,
          _principal: unknown,
          _householdId: string,
          operation: (client: unknown, membership: unknown) => Promise<unknown>
        ) => operation({}, { id: 'm1', householdId: HOUSEHOLD, role: 'family_admin', expiresAt: null })
      };
    });
    const { loadFinanceAjustes } = await import('../src/lib/server/finance.server');
    const ajustes = await loadFinanceAjustes({ id: 'u1' }, HOUSEHOLD, FAKE_POOL);
    expect(ajustes).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('formatImportedAt: revisión T12 #10 — imported_at se pinta en Europe/Madrid, no en el TimeZone de la sesión', () => {
  it('22:30 en Madrid (verano, CEST = UTC+2) se lee 22:30, no 20:30 (lo que daría un ::text sin zona)', () => {
    expect(formatImportedAt(new Date('2026-08-01T20:30:00.000Z'))).toBe('01/08/2026, 22:30');
  });

  it('medianoche en Madrid cae en el día siguiente en UTC: la etiqueta sigue la fecha de Madrid', () => {
    expect(formatImportedAt(new Date('2026-08-01T22:15:00.000Z'))).toBe('02/08/2026, 00:15');
  });
});
