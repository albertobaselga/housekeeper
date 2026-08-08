import { error } from '@sveltejs/kit';
import { can, capabilitiesFor } from '$lib/auth/capabilities';
import { guardForPath } from '$lib/auth/routing';
import { loadSnapshotContacts } from '$lib/server/contacts.server';
import { getHousehold } from '$lib/server/fixtures.server';
import { getSnapshotKeys } from '$lib/server/keys.server';
import { buildCriticalSnapshot } from '$lib/server/snapshot.server';
import type { AppContext } from '$lib/auth/types';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, params, url }) => {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  const household =
    getHousehold(params.householdId) ??
    locals.user.households?.find((candidate) => candidate.id === params.householdId) ??
    null;
  if (!household || !locals.user.householdIds.includes(household.id)) error(404, 'Hogar no encontrado');

  // Enlace directo a una sección fuera del acceso del rol (P2-15): el 403 se
  // lanza aquí (no en hooks) para que aterrice en +error.svelte con lenguaje
  // de casa y un camino de vuelta a Hoy, en vez del fallo crudo de SvelteKit.
  const guard = guardForPath(url.pathname);
  if (guard?.capability && !can(locals.user.role, guard.capability)) {
    error(403, 'Esta parte la lleva la familia.');
  }

  // Contactos reales del hogar para el snapshot crítico (null sin pool: la
  // demo conserva la fixture sintética).
  const snapshotContacts = await loadSnapshotContacts({ id: locals.user.id }, household.id);

  const context: AppContext = {
    user: locals.user,
    household,
    role: locals.user.role,
    capabilities: capabilitiesFor(locals.user.role),
    locale: 'es-ES',
    timeZone: 'Europe/Madrid',
    criticalSnapshot: buildCriticalSnapshot(household.id, locals.user.membershipId, snapshotContacts),
    snapshotPublicKey: getSnapshotKeys().publicKeyRaw,
    synthetic: locals.syntheticOnly
  };
  return { context };
};
