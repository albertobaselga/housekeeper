import { loadRoutines } from '$lib/server/food.server';
import { getRoutinesFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
  const live = locals.user ? await loadRoutines({ id: locals.user.id }, params.householdId) : null;
  if (live) return { live, routines: null };
  // Sin base de datos (o sin membresía autorizada) la demo conserva la fixture.
  return { live: null, routines: getRoutinesFixture() };
};
