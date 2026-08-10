import { error, redirect } from '@sveltejs/kit';

import { getWikiFixture } from '$lib/server/fixtures.server';
import { loadWikiPage } from '$lib/server/wiki.server';
import { parseWikiMarkdown } from '$lib/wiki/markdown';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, depends }) => {
  // PATRÓN DE REFERENCIA (latencia): este load declara la dependencia
  // 'cc:wiki' para que las acciones de la página lo re-ejecuten con
  // `invalidate('cc:wiki')` en vez de `invalidateAll()`. Así el ciclo de
  // acción NO re-ejecuta el load del layout (que reconstruye y firma Ed25519
  // el snapshot crítico en cada pasada): un solo viaje de datos, el mínimo.
  depends('cc:wiki');
  const base = `/h/${encodeURIComponent(params.householdId)}/wiki`;
  const view = locals.user
    ? await loadWikiPage({ id: locals.user.id }, params.householdId, params.slug)
    : null;

  if (view) {
    // Un slug histórico redirige de forma permanente al slug vigente (AC-15).
    if (view.kind === 'redirect') redirect(308, `${base}/${encodeURIComponent(view.slug)}`);
    if (view.kind === 'not_found') error(404, 'Esta nota no está en la guía de esta casa.');
    return {
      view,
      // Título de pestaña de ESTA nota (ver `$lib/app-title`): el layout de la
      // raíz lo antepone al nombre del hogar.
      section: view.revision.title,
      blocks: parseWikiMarkdown(view.revision.bodyMarkdown, { wikiBasePath: base }),
      fixture: null
    };
  }

  // Sin base de datos (o sin membresía autorizada): la demo sirve la fixture.
  const fixture = getWikiFixture().pages.find((page) => page.id === params.slug) ?? null;
  if (!fixture) error(404, 'Esta nota no está en la guía de esta casa.');
  return {
    view: null,
    section: fixture.title,
    blocks: parseWikiMarkdown(fixture.body, { wikiBasePath: base }),
    fixture
  };
};
