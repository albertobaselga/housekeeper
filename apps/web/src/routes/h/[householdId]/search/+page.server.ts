import { loadContacts } from '$lib/server/contacts.server';
import { demoOrUnavailable, fixturesAllowed } from '$lib/server/data-source.server';
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
    // Contactos accionables (AC-19): con pool son los REALES del hogar (RLS).
    // El corpus de demostración solo entra donde no hay hogar real detrás; con
    // base configurada, un directorio ilegible ya no se sustituye por nombres
    // y teléfonos inventados que además ofrecerían llamada directa `tel:`.
    const directory = await loadContacts({ id: locals.user.id }, params.householdId);
    const corpus = directory
      ? directory.contacts.map((contact) => ({
          id: contact.id,
          name: contact.name,
          role: contact.roleLabel,
          phone: contact.phone
        }))
      : demoOrUnavailable(() =>
          getContactsFixture().contacts.map((contact) => ({
            id: contact.id,
            name: contact.name,
            role: contact.role,
            phone: contact.phone
          }))
        );
    const contacts = corpus.filter((contact) => fold(`${contact.name} ${contact.role}`).includes(fold(trimmed)));

    const wiki = await searchWikiPages({ id: locals.user.id }, params.householdId, trimmed, {
      extraResultsFound: contacts.length > 0
    });
    if (wiki) return { live: { query: trimmed, wiki, contacts }, search: null };
  }

  // Sin nada escrito no hay nada que buscar, y para pintar el formulario vacío
  // no hace falta ninguna base de datos: es la respuesta honesta y suficiente.
  if (!trimmed && !fixturesAllowed()) return { live: null, search: null };
  // Con base de datos configurada aquí no hay maqueta que servir: 503 honesto
  // y registrado (data-source.server.ts). Sin base, la demostración sigue.
  return demoOrUnavailable(() => ({ live: null, search: getSearchFixture(query) }));
};
