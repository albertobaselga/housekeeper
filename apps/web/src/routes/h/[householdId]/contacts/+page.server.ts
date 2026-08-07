import { loadContacts } from '$lib/server/contacts.server';
import { getContactsFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
  const directory = locals.user ? await loadContacts({ id: locals.user.id }, params.householdId) : null;
  if (directory) return { directory, contacts: null };
  // Sin base de datos (o sin membresía autorizada) la demo conserva la fixture.
  return { directory: null, contacts: getContactsFixture() };
};
