import { loadContacts } from '$lib/server/contacts.server';
import { getContactsFixture, getSearchFixture } from '$lib/server/fixtures.server';
import { searchWikiPages } from '$lib/server/wiki.server';
import type { PageServerLoad } from './$types';

function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('es');
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const query = url.searchParams.get('q') ?? '';
  const trimmed = query.trim();

  if (locals.user && trimmed) {
    // Contactos accionables (AC-19): con pool son los REALES del hogar (RLS);
    // sin membresía/pool se conserva la fixture. Filtro sin acentos y cada
    // resultado ofrece llamada directa tel:.
    const directory = await loadContacts({ id: locals.user.id }, params.householdId);
    const corpus = directory
      ? directory.contacts.map((contact) => ({
          id: contact.id,
          name: contact.name,
          role: contact.roleLabel,
          phone: contact.phone
        }))
      : getContactsFixture().contacts.map((contact) => ({
          id: contact.id,
          name: contact.name,
          role: contact.role,
          phone: contact.phone
        }));
    const contacts = corpus.filter((contact) => fold(`${contact.name} ${contact.role}`).includes(fold(trimmed)));

    const wiki = await searchWikiPages({ id: locals.user.id }, params.householdId, trimmed, {
      extraResultsFound: contacts.length > 0
    });
    if (wiki) return { live: { query: trimmed, wiki, contacts }, search: null };
  }

  // Sin base de datos (o sin membresía autorizada) la demo conserva la fixture.
  return { live: null, search: getSearchFixture(query) };
};
