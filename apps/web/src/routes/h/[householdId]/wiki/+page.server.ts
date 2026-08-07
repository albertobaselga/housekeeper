import { loadWikiHome } from '$lib/server/wiki.server';
import { getWikiFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, depends }) => {
  // Mismo token que la página de detalle: `invalidate('cc:wiki')` selectivo.
  depends('cc:wiki');
  const home = locals.user
    ? await loadWikiHome({ id: locals.user.id }, params.householdId)
    : null;
  if (home) return { home, wiki: null };
  // Sin base de datos (o sin membresía autorizada) la demo conserva la fixture.
  return { home: null, wiki: getWikiFixture() };
};
