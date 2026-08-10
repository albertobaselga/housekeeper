import { loadCalendar } from '$lib/server/calendar.server';
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { getCalendarFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, depends }) => {
  // Patrón wiki (latencia): `invalidate('cc:calendar')` re-ejecuta solo este load.
  depends('cc:calendar');
  const live = locals.user ? await loadCalendar({ id: locals.user.id }, params.householdId) : null;
  if (live) return { live, calendar: null };
  // Con base de datos configurada aquí no hay maqueta que servir: 503 honesto
  // y registrado (data-source.server.ts). Sin base, la demostración sigue.
  return demoOrUnavailable(() => ({ live: null, calendar: getCalendarFixture() }));
};
