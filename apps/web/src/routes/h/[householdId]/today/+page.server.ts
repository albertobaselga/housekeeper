import { getTodayFixture } from '$lib/server/fixtures.server';
import { loadTodayOverview } from '$lib/server/today.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, depends }) => {
  // Patrón wiki (latencia): `invalidate('cc:today')` re-ejecuta solo este load.
  depends('cc:today');
  const overview = locals.user
    ? await loadTodayOverview({ id: locals.user.id }, params.householdId)
    : null;
  if (overview) return { overview, today: null };
  // Sin base de datos (o sin membresía autorizada) la demo conserva la fixture.
  return { overview: null, today: getTodayFixture() };
};
