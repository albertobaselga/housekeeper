import { loadContacts } from '$lib/server/contacts.server';
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { getContactsFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
  const directory = locals.user ? await loadContacts({ id: locals.user.id }, params.householdId) : null;
  if (directory) return { directory, contacts: null };
  // Con base de datos configurada aquí no hay maqueta que servir: 503 honesto
  // y registrado (data-source.server.ts). Sin base, la demostración sigue.
  return demoOrUnavailable(() => ({ directory: null, contacts: getContactsFixture() }));
};
