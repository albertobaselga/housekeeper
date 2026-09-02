import { DATE_PATTERN, isUuid, monthsAgoISO } from '$lib/finance/filters';
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { loadFinanceEventos } from '$lib/server/finance.server';
import { getFinanceEventosFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends, locals, params, url }) => {
  depends('cc:finance');
  // [FASE 5, T11 · revisión ronda 1, Minor 4] `from`/`to` crudos de la URL
  // llegaban a Postgres tal cual: un `?from=ayer` malformado (o cualquier
  // cadena que no encaje en el patrón ISO) revienta la consulta con 22007,
  // que el catch del cargador confunde con una avería real y registra un 503
  // ruidoso por lo que es una petición mal formada. Mismo patrón de
  // «descartar lo inválido» que ya usa `parseFilters` ($lib/finance/filters).
  const fromParam = url.searchParams.get('from');
  const toParam = url.searchParams.get('to');
  const range = {
    from: fromParam && DATE_PATTERN.test(fromParam) ? fromParam : monthsAgoISO(6),
    to: toParam && DATE_PATTERN.test(toParam) ? toParam : new Date().toISOString().slice(0, 10)
  };
  const open = url.searchParams.get('open');
  const openId = open && isUuid(open) ? open : null;
  const eventos = locals.user
    ? await loadFinanceEventos({ id: locals.user.id }, params.householdId, range, openId)
    : null;
  if (eventos) return { eventos };
  return demoOrUnavailable(() => ({ eventos: getFinanceEventosFixture(range, openId) }));
};
