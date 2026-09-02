import { describe, expect, it } from 'vitest';

import { FinanceApiError, financeApi } from '../src/lib/finance/api';

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const FILTERS = { from: '2026-01-01', to: '2026-08-31', granularity: 'month' as const, accountIds: ['a1'], eventId: null };

function stubFetch(status = 200, body: unknown = {}): { calls: string[]; fetchFn: typeof fetch } {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('cliente de /api/v1/finance', () => {
  it('summary construye la URL canónica con household y filtros', async () => {
    const { calls, fetchFn } = stubFetch();
    await financeApi(HOUSEHOLD, fetchFn).summary(FILTERS);
    expect(calls[0]).toBe(`/api/v1/finance/summary?from=2026-01-01&to=2026-08-31&acc=a1&household=${HOUSEHOLD}`);
  });

  it('series añade granularidad y months; transactionsByIds pide por ids exactos', async () => {
    const { calls, fetchFn } = stubFetch(200, []);
    const api = financeApi(HOUSEHOLD, fetchFn);
    await api.series(FILTERS, 6);
    expect(calls[0]).toContain('/api/v1/finance/series?');
    expect(calls[0]).toContain('g=month');
    expect(calls[0]).toContain('months=6');
    await api.transactionsByIds(['b1', 'b2']);
    // `ids` va PRIMERO: withHousehold hace `set('household', …)` sobre unos
    // params que ya traen `ids`, y `set` de una clave nueva appendea al final.
    expect(calls[1]).toBe(`/api/v1/finance/transactions?ids=b1%2Cb2&household=${HOUSEHOLD}`);
  });

  it('pivot manda dims solo cuando no es el orden por defecto y serializa varios dupev', async () => {
    const DUPEV_A = '20000000-0000-4000-8000-000000000001';
    const DUPEV_B = '20000000-0000-4000-8000-000000000002';
    const { calls, fetchFn } = stubFetch(200, { months: [], dims: [], dupEventIds: [], rows: [] });
    const api = financeApi(HOUSEHOLD, fetchFn);
    await api.pivot(FILTERS);
    expect(calls[0]).not.toContain('dims=');
    expect(calls[0]).not.toContain('dupev=');
    await api.pivot(FILTERS, ['prov', 'cat'], [DUPEV_A, DUPEV_B]);
    expect(calls[1]).toContain('dims=prov%2Ccat');
    expect(calls[1]).toContain(`dupev=${DUPEV_A}%2C${DUPEV_B}`);
    // El orden por defecto (['cat', 'sub']) SÍ pasa por serializeDims (dims.length > 0),
    // a diferencia de la llamada sin argumento de arriba, que ni lo invoca: esta es la
    // que de verdad ejercita la rama «serializeDims devuelve null» desde el cliente.
    await api.pivot(FILTERS, ['cat', 'sub']);
    expect(calls[2]).not.toContain('dims=');
  });

  it('eventDetail codifica el id en el path para no cambiar de recurso', async () => {
    const { calls, fetchFn } = stubFetch(200, {});
    const api = financeApi(HOUSEHOLD, fetchFn);
    const RISKY_ID = '../summary?x';
    await api.eventDetail(RISKY_ID, FILTERS);
    expect(calls[0]).toBe(
      `/api/v1/finance/events/${encodeURIComponent(RISKY_ID)}?from=2026-01-01&to=2026-08-31&acc=a1&household=${HOUSEHOLD}`
    );
    expect(calls[0]).not.toContain('events/../summary');
  });

  it('una respuesta no-ok se convierte en FinanceApiError con su status', async () => {
    const { fetchFn } = stubFetch(503);
    await expect(financeApi(HOUSEHOLD, fetchFn).summary(FILTERS)).rejects.toBeInstanceOf(FinanceApiError);
    await expect(financeApi(HOUSEHOLD, fetchFn).summary(FILTERS)).rejects.toMatchObject({ status: 503 });
  });

  it('una respuesta no-ok conserva el cuerpo del servidor como mensaje de error', async () => {
    const fetchFn = (async () =>
      new Response('límite de exportación excedido', { status: 429 })) as typeof fetch;
    await expect(financeApi(HOUSEHOLD, fetchFn).summary(FILTERS)).rejects.toMatchObject({
      status: 429,
      message: 'límite de exportación excedido'
    });
  });

  it('una respuesta ok con cuerpo no-JSON se convierte en FinanceApiError, no en SyntaxError', async () => {
    const fetchFn = (async () =>
      new Response('<html>sesión caducada</html>', { status: 200 })) as typeof fetch;
    await expect(financeApi(HOUSEHOLD, fetchFn).summary(FILTERS)).rejects.toBeInstanceOf(FinanceApiError);
    await expect(financeApi(HOUSEHOLD, fetchFn).summary(FILTERS)).rejects.toMatchObject({ status: 200 });
  });
});
