import { demoOrUnavailable } from '$lib/server/data-source.server';
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
  // Con base de datos configurada aquí no hay maqueta que servir: 503 honesto
  // y registrado (data-source.server.ts). Sin base, la demostración sigue.
  return demoOrUnavailable(() => ({ overview: null, today: getTodayFixture() }));
};
