import { error, redirect } from '@sveltejs/kit';

import { getWikiFixture } from '$lib/server/fixtures.server';
import { loadWikiPage } from '$lib/server/wiki.server';
import { parseWikiMarkdown } from '$lib/wiki/markdown';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
  const base = `/h/${encodeURIComponent(params.householdId)}/wiki`;
  const view = locals.user
    ? await loadWikiPage({ id: locals.user.id }, params.householdId, params.slug)
    : null;

  if (view) {
    // Un slug histórico redirige de forma permanente al slug vigente (AC-15).
    if (view.kind === 'redirect') redirect(308, `${base}/${encodeURIComponent(view.slug)}`);
    if (view.kind === 'not_found') error(404, 'Esta página de la wiki no existe en este hogar.');
    return {
      view,
      blocks: parseWikiMarkdown(view.revision.bodyMarkdown, { wikiBasePath: base }),
      fixture: null
    };
  }

  // Sin base de datos (o sin membresía autorizada): la demo sirve la fixture.
  const fixture = getWikiFixture().pages.find((page) => page.id === params.slug) ?? null;
  if (!fixture) error(404, 'Esta página de la wiki no existe en este hogar.');
  return {
    view: null,
    blocks: parseWikiMarkdown(fixture.body, { wikiBasePath: base }),
    fixture
  };
};
