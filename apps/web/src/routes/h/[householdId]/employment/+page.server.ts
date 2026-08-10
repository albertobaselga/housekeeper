import { loadEmploymentOverview } from '$lib/server/employment.server';
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { getEmploymentFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, depends }) => {
  // Patrón wiki (latencia): `invalidate('cc:employment')` re-ejecuta solo este load.
  depends('cc:employment');
  const overview = locals.user
    ? await loadEmploymentOverview({ id: locals.user.id }, params.householdId)
    : null;
  if (overview) return { overview, employment: null };
  // Con base de datos configurada aquí no hay maqueta que servir: 503 honesto
  // y registrado (data-source.server.ts). Sin base, la demostración sigue.
  return demoOrUnavailable(() => ({ overview: null, employment: getEmploymentFixture() }));
};
