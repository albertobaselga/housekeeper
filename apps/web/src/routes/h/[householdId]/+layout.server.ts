import { error } from '@sveltejs/kit';
import { can, capabilitiesFor } from '$lib/auth/capabilities';
import { guardForPath, pickHousehold } from '$lib/auth/routing';
import { getAuth } from '$lib/server/auth.server';
import { loadSnapshotContacts } from '$lib/server/contacts.server';
import { getHousehold } from '$lib/server/fixtures.server';
import { getSnapshotKeys } from '$lib/server/keys.server';
import { buildCriticalSnapshot, loadSnapshotHousehold } from '$lib/server/snapshot.server';
import type { AppContext } from '$lib/auth/types';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, params, url }) => {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  // El hogar de la URL, y su nombre real primero: la fixture sintética es solo
  // el respaldo de la demo sin base de datos. Al revés, una instalación cuyo
  // hogar compartiera identificador con la fixture se anunciaría con el nombre
  // inventado en vez de con el suyo.
  const household =
    pickHousehold(locals.user.households, params.householdId) ??
    getHousehold(params.householdId) ??
    null;
  if (!household || !locals.user.householdIds.includes(household.id)) error(404, 'Hogar no encontrado');

  // Enlace directo a una sección fuera del acceso del rol (P2-15): el 403 se
  // lanza aquí (no en hooks) para que aterrice en +error.svelte con lenguaje
  // de casa y un camino de vuelta a Hoy, en vez del fallo crudo de SvelteKit.
  const guard = guardForPath(url.pathname);
  if (guard?.capability && !can(locals.user.role, guard.capability)) {
    error(403, 'Esta parte la lleva la familia.');
  }

  // Contenido real del hogar para el snapshot crítico (null sin pool: la demo
  // conserva la fixture sintética). Las dos lecturas van en paralelo: cada una
  // abre su propia transacción autorizada y no dependen entre sí.
  const [snapshotContacts, snapshotHousehold] = await Promise.all([
    loadSnapshotContacts({ id: locals.user.id }, household.id),
    loadSnapshotHousehold({ id: locals.user.id }, household.id)
  ]);

  const context: AppContext = {
    user: locals.user,
    household,
    role: locals.user.role,
    capabilities: capabilitiesFor(locals.user.role),
    locale: 'es-ES',
    timeZone: 'Europe/Madrid',
    criticalSnapshot: buildCriticalSnapshot(
      household.id,
      locals.user.membershipId,
      snapshotContacts,
      snapshotHousehold
    ),
    snapshotPublicKey: getSnapshotKeys().publicKeyRaw,
    synthetic: locals.syntheticOnly,
    passwordAuth: Boolean(getAuth())
  };
  return { context };
};
