import { loadFoodCatalog, loadRecipe } from '$lib/server/food.server';
import { getRecipesFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const load: PageServerLoad = async ({ locals, params, url, depends }) => {
  // Patrón wiki (latencia): `invalidate('cc:recipes')` re-ejecuta solo este load.
  depends('cc:recipes');
  const catalog = locals.user ? await loadFoodCatalog({ id: locals.user.id }, params.householdId) : null;
  if (catalog) {
    const requested = url.searchParams.get('receta');
    const pageId = requested && UUID_PATTERN.test(requested) ? requested : null;
    const recipe = pageId ? await loadRecipe({ id: locals.user!.id }, params.householdId, pageId) : null;
    return { catalog, recipe, recipes: null };
  }
  // Sin base de datos (o sin membresía autorizada) la demo conserva la fixture.
  return { catalog: null, recipe: null, recipes: getRecipesFixture() };
};
