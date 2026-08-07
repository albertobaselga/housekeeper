import { loadEmergencyContacts } from '$lib/server/contacts.server';
import { getEmergencyFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
  const live = locals.user ? await loadEmergencyContacts({ id: locals.user.id }, params.householdId) : null;
  if (live) return { live, emergency: null };
  // Sin base de datos (o sin membresía autorizada) la demo conserva la maqueta.
  return { live: null, emergency: getEmergencyFixture() };
};
