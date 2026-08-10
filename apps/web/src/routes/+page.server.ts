import { redirect } from '@sveltejs/kit';

import { landingHouseholdId } from '$lib/auth/membership';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
  const household = landingHouseholdId(locals.user);
  if (!household) redirect(303, '/login');
  redirect(303, `/h/${encodeURIComponent(household)}/today`);
};
