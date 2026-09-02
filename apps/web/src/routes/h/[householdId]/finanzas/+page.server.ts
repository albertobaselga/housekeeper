import { demoOrUnavailable } from '$lib/server/data-source.server';
import { loadFinanceDashboard } from '$lib/server/finance.server';
import { getFinanceDashboardFixture } from '$lib/server/fixtures.server';
import { parseFilters, todayLocal } from '$lib/finance/filters';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url, depends }) => {
  // Token propio del módulo: invalidate('cc:finance') re-ejecuta solo esto.
  depends('cc:finance');
  // Los filtros viajan en la URL (compartible, con atrás/adelante); cambiar
  // el periodo es una navegación SPA que re-ejecuta este load sin recargar.
  const filters = parseFilters(url.searchParams, todayLocal());
  const dashboard = locals.user
    ? await loadFinanceDashboard({ id: locals.user.id }, params.householdId, filters)
    : null;
  if (dashboard) return { dashboard, demo: false };
  // Con base configurada aquí no hay maqueta: 503 honesto (data-source.server).
  return demoOrUnavailable(() => ({ dashboard: getFinanceDashboardFixture(filters), demo: true }));
};
