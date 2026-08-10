import { error } from '@sveltejs/kit';
import { can, capabilitiesFor } from '$lib/auth/capabilities';
import { guardForPath } from '$lib/auth/routing';
import { getAuth } from '$lib/server/auth.server';
import { loadSnapshotContacts } from '$lib/server/contacts.server';
import { fixturesAllowed, isDataUnavailable } from '$lib/server/data-source.server';
import { getHousehold } from '$lib/server/fixtures.server';
import { getSnapshotKeys } from '$lib/server/keys.server';
import { buildCriticalSnapshot, loadSnapshotHousehold } from '$lib/server/snapshot.server';
import type { AppContext } from '$lib/auth/types';
import type { LayoutServerLoad } from './$types';

/**
 * Contenido del snapshot, tolerante a averías A PROPÓSITO.
 *
 * Este layout envuelve TODAS las pantallas del hogar, incluida Emergencias. Si
 * una avería de lectura lo tumbara, tumbaría también la única pantalla que no
 * puede caerse. Así que aquí —y solo aquí— un 503 de los cargadores se traga:
 * el snapshot sale sin contenido, que `getCriticalSnapshotPayload` marca como
 * parcial (el 112 y nada más), nunca con la maqueta.
 */
async function snapshotContentOrNothing<T>(read: Promise<T | null>): Promise<T | null> {
  try {
    return await read;
  } catch (cause) {
    if (isDataUnavailable(cause)) return null;
    throw cause;
  }
}

export const load: LayoutServerLoad = async ({ locals, params, url }) => {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  // El hogar REAL de la persona manda; la maqueta solo completa donde no hay
  // base de datos. Al revés, un hogar real que compartiera identificador con
  // la fixture se pintaría con el nombre y el subtítulo inventados.
  const household =
    locals.user.households?.find((candidate) => candidate.id === params.householdId) ??
    (fixturesAllowed() ? getHousehold(params.householdId) : null) ??
    null;
  if (!household || !locals.user.householdIds.includes(household.id)) error(404, 'Hogar no encontrado');

  // Enlace directo a una sección fuera del acceso del rol (P2-15): el 403 se
  // lanza aquí (no en hooks) para que aterrice en +error.svelte con lenguaje
  // de casa y un camino de vuelta a Hoy, en vez del fallo crudo de SvelteKit.
  const guard = guardForPath(url.pathname);
  if (guard?.capability && !can(locals.user.role, guard.capability)) {
    error(403, 'Esta parte la lleva la familia.');
  }

  // Contenido real del hogar para el snapshot crítico. Las dos lecturas van en
  // paralelo: cada una abre su propia transacción autorizada y no dependen
  // entre sí.
  const [snapshotContacts, snapshotHousehold] = await Promise.all([
    snapshotContentOrNothing(loadSnapshotContacts({ id: locals.user.id }, household.id)),
    snapshotContentOrNothing(loadSnapshotHousehold({ id: locals.user.id }, household.id))
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
