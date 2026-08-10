import { loadRoutines } from '$lib/server/food.server';
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { getRoutinesFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, depends }) => {
  // Patrón wiki (latencia): `invalidate('cc:routines')` re-ejecuta solo este load.
  depends('cc:routines');
  const live = locals.user ? await loadRoutines({ id: locals.user.id }, params.householdId) : null;
  if (live) return { live, routines: null };
  // Con base de datos configurada aquí no hay maqueta que servir: 503 honesto
  // y registrado (data-source.server.ts). Sin base, la demostración sigue.
  return demoOrUnavailable(() => ({ live: null, routines: getRoutinesFixture() }));
};
