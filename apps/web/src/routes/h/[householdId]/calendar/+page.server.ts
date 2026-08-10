import { loadCalendar } from '$lib/server/calendar.server';
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { getCalendarFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url, depends }) => {
  // Patrón wiki (latencia): `invalidate('cc:calendar')` re-ejecuta solo este load.
  depends('cc:calendar');
  // El alcance y el día viven en la URL para que la vista se pueda compartir y
  // se sirva ya pintada; dentro de la página son estado del navegador, que es
  // lo que permite cambiar de semana sin red. Un valor inventado cae en
  // «semana» y en hoy (resolveScope / resolveAnchor).
  const request = { scope: url.searchParams.get('v'), anchor: url.searchParams.get('d') };
  const live = locals.user
    ? await loadCalendar({ id: locals.user.id }, params.householdId, request)
    : null;
  if (live) return { live, calendar: null };
  // Con base de datos configurada aquí no hay maqueta que servir: 503 honesto
  // y registrado (data-source.server.ts). Sin base, la demostración sigue.
  return demoOrUnavailable(() => ({ live: null, calendar: getCalendarFixture() }));
};
