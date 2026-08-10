import { loadWikiHome } from '$lib/server/wiki.server';
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { getWikiFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, depends }) => {
  // Mismo token que la página de detalle: `invalidate('cc:wiki')` selectivo.
  depends('cc:wiki');
  const home = locals.user
    ? await loadWikiHome({ id: locals.user.id }, params.householdId)
    : null;
  if (home) return { home, wiki: null };
  // Con base de datos configurada aquí no hay maqueta que servir: 503 honesto
  // y registrado (data-source.server.ts). Sin base, la demostración sigue.
  return demoOrUnavailable(() => ({ home: null, wiki: getWikiFixture() }));
};
