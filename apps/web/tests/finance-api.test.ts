import { describe, expect, it } from 'vitest';

import {
  FinanceApiError,
  financeApi,
  isFinanceImportConfirmResult,
  isFinanceImportPreview,
  isRecord
} from '../src/lib/finance/api';

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

  it('una respuesta ok con cuerpo JSON `null` se convierte en FinanceApiError (T12-R1)', async () => {
    // El JSON.parse de `null` no lanza (a diferencia del HTML de arriba): sin
    // la guarda de `isRecord`, `getJson` devolvía `null` tipado como si fuera
    // el DTO esperado, y quien lo desestructurase reventaba más abajo con un
    // TypeError sin relación aparente con la respuesta del servidor.
    const { fetchFn } = stubFetch(200, null);
    await expect(financeApi(HOUSEHOLD, fetchFn).summary(FILTERS)).rejects.toBeInstanceOf(FinanceApiError);
    await expect(financeApi(HOUSEHOLD, fetchFn).summary(FILTERS)).rejects.toMatchObject({
      status: 200,
      message: 'respuesta no válida'
    });
  });
});

describe('isRecord — guarda de narrowing sin `as` (T12-R1)', () => {
  it('un objeto (incluso vacío) es un record', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('un array también es un record: `getJson` lo necesita para los DTOs que son listas', () => {
    expect(isRecord([])).toBe(true);
    expect(isRecord([1, 2, 3])).toBe(true);
  });

  it('null, undefined y los primitivos no son records', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord('texto')).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(true)).toBe(false);
  });
});

const VALID_PREVIEW = {
  bank: 'caixabank',
  newCount: 3,
  dupCount: 1,
  unknownRefs: ['REF1'],
  sample: [{ opDate: '2026-08-01', concept: 'Recibo', provider: null, amountCents: '-1000' }]
};

describe('isFinanceImportPreview — guarda de forma de la previsualización (T12-R1)', () => {
  it('un objeto válido pasa la guarda y queda tipado', () => {
    expect(isFinanceImportPreview(VALID_PREVIEW)).toBe(true);
  });

  it('null no pasa la guarda', () => {
    expect(isFinanceImportPreview(null)).toBe(false);
  });

  it('un array no pasa la guarda (aunque `isRecord` lo acepte)', () => {
    expect(isFinanceImportPreview([VALID_PREVIEW])).toBe(false);
  });

  it('un objeto sin los campos esperados no pasa la guarda', () => {
    expect(isFinanceImportPreview({})).toBe(false);
    expect(isFinanceImportPreview({ bank: 'caixabank' })).toBe(false);
    // Tipo equivocado en un campo presente: `newCount` como cadena.
    expect(isFinanceImportPreview({ ...VALID_PREVIEW, newCount: '3' })).toBe(false);
  });

  // [Rev 0, Minor 2] Antes solo se comprobaba `Array.isArray`: un elemento de
  // otra forma dentro de `sample`/`unknownRefs` pasaba la guarda entera y
  // reventaba más abajo (`formatCents(row.amountCents)`,
  // `row.provider || row.concept`) con el mismo `TypeError` sin contexto que
  // la guarda existe para evitar.
  it('un elemento de `sample` con la forma equivocada no pasa la guarda', () => {
    expect(isFinanceImportPreview({ ...VALID_PREVIEW, sample: [{ opDate: '2026-08-01' }] })).toBe(false);
    expect(
      isFinanceImportPreview({
        ...VALID_PREVIEW,
        sample: [{ opDate: '2026-08-01', concept: 'Recibo', provider: null, amountCents: -1000 }]
      })
    ).toBe(false);
  });

  it('un `provider` de cadena en `sample` sí pasa (no solo `null`)', () => {
    expect(
      isFinanceImportPreview({
        ...VALID_PREVIEW,
        sample: [{ opDate: '2026-08-01', concept: 'Recibo', provider: 'Mercadona', amountCents: '-1000' }]
      })
    ).toBe(true);
  });

  it('un elemento de `unknownRefs` que no es cadena no pasa la guarda', () => {
    expect(isFinanceImportPreview({ ...VALID_PREVIEW, unknownRefs: [42] })).toBe(false);
  });
});

describe('isFinanceImportConfirmResult — guarda de forma del resultado de confirmar (T12-R1)', () => {
  it('un objeto válido pasa la guarda y queda tipado', () => {
    expect(isFinanceImportConfirmResult({ newCount: 2, dupCount: 0 })).toBe(true);
  });

  it('null, un array y un objeto sin campos no pasan la guarda', () => {
    expect(isFinanceImportConfirmResult(null)).toBe(false);
    expect(isFinanceImportConfirmResult([])).toBe(false);
    expect(isFinanceImportConfirmResult({})).toBe(false);
  });
});
