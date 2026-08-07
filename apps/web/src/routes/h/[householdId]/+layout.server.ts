import { error } from '@sveltejs/kit';
import { capabilitiesFor } from '$lib/auth/capabilities';
import { getCriticalSnapshot, getHousehold } from '$lib/server/fixtures.server';
import type { AppContext } from '$lib/auth/types';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, params }) => {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  const household = getHousehold(params.householdId);
  if (!household || !locals.user.householdIds.includes(household.id)) error(404, 'Hogar no encontrado');

  const context: AppContext = {
    user: locals.user,
    household,
    role: locals.user.role,
    capabilities: capabilitiesFor(locals.user.role),
    locale: 'es-ES',
    timeZone: 'Europe/Madrid',
    criticalSnapshot: getCriticalSnapshot(household.id)
  };
  return { context };
};
