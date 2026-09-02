import { isUuid, parseDateRange } from '$lib/finance/filters';
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { loadFinanceEventos } from '$lib/server/finance.server';
import { getFinanceEventosFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends, locals, params, url }) => {
  depends('cc:finance');
  // [FASE 5, T11 · revisión ronda 1, Minor 4] `from`/`to` crudos de la URL
  // llegaban a Postgres tal cual: un `?from=ayer` malformado revienta la
  // consulta con 22007, que el catch del cargador confunde con una avería real
  // y registra un 503 ruidoso por lo que es una petición mal formada.
  // [FASE 5 · despacho de cierre, T11-R3 + F5-M3] Aquella corrección validaba
  // la FORMA pero no el calendario (`2026-13-40` pasaba), no imponía
  // `to >= from` y anclaba el «hoy» en UTC en vez de en la zona del hogar. Las
  // tres cosas viven ahora en `parseDateRange`, compartida con Revisión.
  const range = parseDateRange(url.searchParams);
  const open = url.searchParams.get('open');
  const openId = open && isUuid(open) ? open : null;
  const eventos = locals.user
    ? await loadFinanceEventos({ id: locals.user.id }, params.householdId, range, openId)
    : null;
  if (eventos) return { eventos };
  return demoOrUnavailable(() => ({ eventos: getFinanceEventosFixture(range, openId) }));
};
