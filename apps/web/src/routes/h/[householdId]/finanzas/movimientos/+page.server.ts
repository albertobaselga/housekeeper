import { demoOrUnavailable } from '$lib/server/data-source.server';
import { loadFinanceMovimientos, type FinanceMovimientosQuery } from '$lib/server/finance.server';
import { getFinanceMovimientosFixture } from '$lib/server/fixtures.server';
import { isUuid, parseFilters, todayLocal } from '$lib/finance/filters';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 100;

export const load: PageServerLoad = async ({ locals, params, url, depends }) => {
  depends('cc:finance');
  const filters = parseFilters(url.searchParams, todayLocal());
  // Filtros locales de la pantalla (contrato del original): q, cat, rec.
  // Lo malformado se ignora en el load; la API, en cambio, responde 400.
  const category = url.searchParams.get('cat');
  const recurrence = url.searchParams.get('rec');
  // offset es paginación, no dinero: Number es correcto aquí.
  const offsetRaw = Number(url.searchParams.get('offset') ?? '0');
  // Anotado explícitamente: sin el tipo de destino, el ternario de `recurrence`
  // ensancha a `string | null` dentro del literal (el narrowing de igualdad
  // sobre una variable ya unida no queda "fresco" al entrar en el objeto) y
  // `svelte-check` lo rechaza contra `FinanceMovimientosQuery['recurrence']`.
  const query: FinanceMovimientosQuery = {
    q: url.searchParams.get('q') || null,
    categoryId: category && isUuid(category) ? category : null,
    recurrence: recurrence === 'recurrente' || recurrence === 'extraordinario' ? recurrence : null,
    limit: PAGE_SIZE,
    offset: Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0
  };
  const movimientos = locals.user
    ? await loadFinanceMovimientos({ id: locals.user.id }, params.householdId, filters, query)
    : null;
  if (movimientos) return { movimientos, demo: false };
  return demoOrUnavailable(() => ({ movimientos: getFinanceMovimientosFixture(filters), demo: true }));
};
