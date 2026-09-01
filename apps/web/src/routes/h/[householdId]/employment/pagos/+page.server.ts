import { employmentHrefBases, loadEmploymentOverview } from '$lib/server/employment.server';
import { demoOrUnavailable } from '$lib/server/data-source.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url, depends }) => {
  // Mismo token que el resumen: cerrar, pagar o confirmar invalida
  // 'cc:employment' y el historial se refresca del mismo load.
  depends('cc:employment');
  const selectedAgreementId = url.searchParams.get('empleada');
  const overview = locals.user
    ? await loadEmploymentOverview(
        { id: locals.user.id },
        params.householdId,
        undefined,
        undefined,
        selectedAgreementId,
        employmentHrefBases(locals.user, params.householdId, selectedAgreementId)
      )
    : null;
  if (overview) return { overview };
  // La maqueta de demostración vive solo en el Resumen: aquí, sin base de
  // datos, la página dice su estado vacío.
  return demoOrUnavailable(() => ({ overview: null }));
};
