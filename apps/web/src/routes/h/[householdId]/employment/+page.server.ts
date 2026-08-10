import { loadEmploymentOverview } from '$lib/server/employment.server';
import { getEmploymentFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url, depends }) => {
  // Patrón wiki (latencia): `invalidate('cc:employment')` re-ejecuta solo este load.
  depends('cc:employment');
  // De quién es el expediente que se está mirando. Va en la URL para que se
  // pueda compartir y volver atrás, y para que este load se repita al cambiar
  // de persona sin recargar la página entera. No es una reja: la lista de
  // acuerdos la filtra la RLS y pedir el de otra cae en el propio.
  const selectedAgreementId = url.searchParams.get('empleada');
  const overview = locals.user
    ? await loadEmploymentOverview(
        { id: locals.user.id },
        params.householdId,
        undefined,
        undefined,
        selectedAgreementId
      )
    : null;
  if (overview) return { overview, employment: null };
  // Sin base de datos (o sin membresía autorizada) la demo conserva la fixture.
  return { overview: null, employment: getEmploymentFixture() };
};
