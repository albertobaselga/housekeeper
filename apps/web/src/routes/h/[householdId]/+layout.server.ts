import { error } from '@sveltejs/kit';
import { can, capabilitiesFor } from '$lib/auth/capabilities';
import { membershipIn } from '$lib/auth/membership';
import { guardForPath } from '$lib/auth/routing';
import { getAuth } from '$lib/server/auth.server';
import { loadSnapshotContacts } from '$lib/server/contacts.server';
import { getHousehold } from '$lib/server/fixtures.server';
import { getSnapshotKeys } from '$lib/server/keys.server';
import { buildCriticalSnapshot, loadSnapshotHousehold } from '$lib/server/snapshot.server';
import type { AppContext } from '$lib/auth/types';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, params, url }) => {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  // El papel sale del hogar de la URL, no de la persona: la membresía manda y
  // se busca por `params.householdId`. Sin membresía viva aquí, el hogar no
  // existe para quien mira.
  const membership = membershipIn(locals.user, params.householdId);
  if (!membership) error(404, 'Hogar no encontrado');
  const household =
    getHousehold(params.householdId) ??
    locals.user.households?.find((candidate) => candidate.id === params.householdId) ??
    null;
  if (!household) error(404, 'Hogar no encontrado');

  // Enlace directo a una sección fuera del acceso del rol (P2-15): el 403 se
  // lanza aquí (no en hooks) para que aterrice en +error.svelte con lenguaje
  // de casa y un camino de vuelta a Hoy, en vez del fallo crudo de SvelteKit.
  const guard = guardForPath(url.pathname);
  if (guard?.capability && !can(membership.role, guard.capability)) {
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
