import { error } from '@sveltejs/kit';
import { capabilitiesFor } from '$lib/auth/capabilities';
import { getHousehold } from '$lib/server/fixtures.server';
import { getSnapshotKeys } from '$lib/server/keys.server';
import { buildCriticalSnapshot } from '$lib/server/snapshot.server';
import type { AppContext } from '$lib/auth/types';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, params }) => {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  const household =
    getHousehold(params.householdId) ??
    locals.user.households?.find((candidate) => candidate.id === params.householdId) ??
    null;
  if (!household || !locals.user.householdIds.includes(household.id)) error(404, 'Hogar no encontrado');

  const context: AppContext = {
    user: locals.user,
    household,
    role: locals.user.role,
    capabilities: capabilitiesFor(locals.user.role),
    locale: 'es-ES',
    timeZone: 'Europe/Madrid',
    criticalSnapshot: buildCriticalSnapshot(household.id, locals.user.membershipId),
    snapshotPublicKey: getSnapshotKeys().publicKeyRaw,
    synthetic: locals.syntheticOnly
  };
  return { context };
};
