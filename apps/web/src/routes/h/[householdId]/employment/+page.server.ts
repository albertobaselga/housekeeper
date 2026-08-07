import { loadEmploymentOverview } from '$lib/server/employment.server';
import { getEmploymentFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
  const overview = locals.user
    ? await loadEmploymentOverview({ id: locals.user.id }, params.householdId)
    : null;
  if (overview) return { overview, employment: null };
  // Sin base de datos (o sin membresía autorizada) la demo conserva la fixture.
  return { overview: null, employment: getEmploymentFixture() };
};
