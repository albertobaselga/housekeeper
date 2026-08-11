import { error } from '@sveltejs/kit';
import { can, capabilitiesFor } from '$lib/auth/capabilities';
import { membershipIn } from '$lib/auth/membership';
import { guardForPath, pickHousehold } from '$lib/auth/routing';
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
  // El papel sale del hogar de la URL, no de la persona: la membresía manda y
  // se busca por `params.householdId`. Sin membresía viva aquí, el hogar no
  // existe para quien mira.
  const membership = membershipIn(locals.user, params.householdId);
  if (!membership) error(404, 'Hogar no encontrado');
  // Y su NOMBRE sale del mismo sitio: el resumen real del hogar de la URL. La
  // maqueta es solo el respaldo de la demo sin base de datos, y solo cuando las
  // maquetas están permitidas: una instalación cuyo hogar compartiera
  // identificador con la fixture se anunciaría con el nombre inventado en vez
  // de con el suyo.
  const household =
    pickHousehold(locals.user.households, params.householdId) ??
    (fixturesAllowed() ? getHousehold(params.householdId) : null) ??
    null;
  if (!household) error(404, 'Hogar no encontrado');

  // Enlace directo a una sección fuera del acceso del rol (P2-15): el 403 se
  // lanza aquí (no en hooks) para que aterrice en +error.svelte con lenguaje
  // de casa y un camino de vuelta a Hoy, en vez del fallo crudo de SvelteKit.
  const guard = guardForPath(url.pathname);
  if (guard?.capability && !can(membership.role, guard.capability)) {
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
    membershipId: membership.membershipId,
    role: membership.role,
    capabilities: capabilitiesFor(membership.role),
    locale: 'es-ES',
    timeZone: 'Europe/Madrid',
    criticalSnapshot: buildCriticalSnapshot(
      household.id,
      membership.membershipId,
      snapshotContacts,
      snapshotHousehold
    ),
    snapshotPublicKey: getSnapshotKeys().publicKeyRaw,
    synthetic: locals.syntheticOnly,
    passwordAuth: Boolean(getAuth())
  };
  return { context };
};
