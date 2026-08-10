import { error, redirect } from '@sveltejs/kit';

import { loadGuideBook } from '$lib/server/wiki.server';
import { parseWikiMarkdown } from '$lib/wiki/markdown';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, depends }) => {
  depends('cc:wiki');
  const base = `/h/${encodeURIComponent(params.householdId)}/wiki`;
  const loaded = locals.user
    ? await loadGuideBook({ id: locals.user.id }, params.householdId, params.slug)
    : null;

  // Sin base de datos (demo con fixture) el modo libro no tiene corpus real que
  // recorrer: la Guía se sigue consultando nota a nota.
  if (!loaded) redirect(303, base);
  if (loaded.kind === 'redirect') {
    redirect(308, `${base}/libro/${encodeURIComponent(loaded.slug)}`);
  }
  if (loaded.kind !== 'book') {
    error(404, 'Esta nota no está en la guía de esta casa.');
  }

  return {
    // El título de la pestaña es el de la nota que se está leyendo; lo pinta el
    // layout de la raíz, que es quien tiene el único <title> de la aplicación.
    section: loaded.book.note.title,
    book: loaded.book,
    blocks: parseWikiMarkdown(loaded.book.note.bodyMarkdown, { wikiBasePath: base })
  };
};
