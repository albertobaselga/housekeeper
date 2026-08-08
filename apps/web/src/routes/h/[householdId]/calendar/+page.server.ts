import { loadCalendar } from '$lib/server/calendar.server';
import { getCalendarFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, depends }) => {
  // Patrón wiki (latencia): `invalidate('cc:calendar')` re-ejecuta solo este load.
  depends('cc:calendar');
  const live = locals.user ? await loadCalendar({ id: locals.user.id }, params.householdId) : null;
  if (live) return { live, calendar: null };
  // Sin base de datos (o sin membresía autorizada) la demo conserva la fixture.
  return { live: null, calendar: getCalendarFixture() };
};
