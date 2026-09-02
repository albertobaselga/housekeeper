import { demoOrUnavailable } from '$lib/server/data-source.server';
import { loadFinanceAnalitica } from '$lib/server/finance.server';
import { getFinanceAnaliticaFixture } from '$lib/server/fixtures.server';
import { isUuid, parseFilters, todayLocal } from '$lib/finance/filters';
import { parseIdList } from '$lib/finance/pivot-state';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends, locals, params, url }) => {
  // Token canónico de invalidación del módulo (doc de interfaces): lo dispara
  // el pivot tras cada comando con invalidate('cc:finance').
  depends('cc:finance');

  const filters = parseFilters(url.searchParams, todayLocal());
  // Partidas excluidas de KPIs/gráfica (?exev=, CSV): solo ids con forma de
  // UUID viajan a la lectura SQL (Ruling R24); lo demás se ignora en silencio,
  // igual que hace parseFilters con el resto de parámetros malformados.
  const excludeEventIds = parseIdList(url.searchParams.get('exev')).filter(isUuid);

  const analitica = locals.user
    ? await loadFinanceAnalitica({ id: locals.user.id }, params.householdId, filters, excludeEventIds)
    : null;
  if (analitica) return { analitica: { ...analitica, filters }, demo: false };
  // null ⇒ sin concesión viva (o sin usuario): cae a la maqueta/503 de abajo.
  return demoOrUnavailable(() => ({
    analitica: { ...getFinanceAnaliticaFixture(filters), filters },
    demo: true
  }));
};
