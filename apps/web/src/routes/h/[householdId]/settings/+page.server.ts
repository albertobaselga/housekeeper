import { loadAccessOverview } from '$lib/server/access.server';
import { getSettingsFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => ({
  settings: getSettingsFixture(),
  // Solo el family_admin con base de datos real recibe la vista de accesos;
  // en cualquier otro caso `access` es null y la página conserva la maqueta.
  access: locals.user ? await loadAccessOverview({ id: locals.user.id }, params.householdId) : null
});
