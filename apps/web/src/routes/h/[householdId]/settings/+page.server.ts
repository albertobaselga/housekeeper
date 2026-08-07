import { getSettingsFixture } from '$lib/server/fixtures.server';
import { canDownloadHandover } from '$lib/server/handover.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
  // La descarga del traspaso solo aparece con datos reales: membresía
  // family_admin verificada bajo RLS (sin pool o sin membresía → false y la
  // página conserva únicamente la fixture de demostración).
  const canHandover = locals.user
    ? await canDownloadHandover({ id: locals.user.id }, params.householdId)
    : false;
  return {
    settings: getSettingsFixture(),
    handover: canHandover ? { householdId: params.householdId } : null
  };
};
