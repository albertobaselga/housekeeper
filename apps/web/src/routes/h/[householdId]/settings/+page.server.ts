import { loadAccessOverview } from '$lib/server/access.server';
import { getSettingsFixture } from '$lib/server/fixtures.server';
import { canDownloadHandover } from '$lib/server/handover.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, depends }) => {
  // Patrón wiki (latencia): `invalidate('cc:settings')` re-ejecuta solo este load.
  depends('cc:settings');
  // Ambas secciones reales (accesos y traspaso) solo existen para el
  // family_admin con base de datos; en cualquier otro caso son null/false y la
  // página conserva únicamente la maqueta de demostración.
  const access = locals.user
    ? await loadAccessOverview({ id: locals.user.id }, params.householdId)
    : null;
  const canHandover = locals.user
    ? await canDownloadHandover({ id: locals.user.id }, params.householdId)
    : false;
  return {
    settings: getSettingsFixture(),
    access,
    handover: canHandover ? { householdId: params.householdId } : null
  };
};
