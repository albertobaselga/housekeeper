import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
  redirect(303, `/h/${encodeURIComponent(params.householdId)}/today`);
};
