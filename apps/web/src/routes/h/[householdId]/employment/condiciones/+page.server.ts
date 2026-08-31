import { loadEmploymentOverview } from '$lib/server/employment.server';
import type { PageServerLoad } from './$types';

/**
 * Condiciones de contrato en lenguaje llano.
 *
 * Reutiliza el mismo cargador que el expediente: lo que llega aquí ya pasó por
 * la RLS de 0021, así que para la empleada `terms` solo contiene los conceptos
 * que le aplican. No hay ningún filtro en esta capa —no lo habría dónde poner—
 * y por eso el JSON de la página tampoco lleva lo que no le aplica.
 *
 * Ruta propia y no una sección más del expediente: así vive en su propio trozo
 * de JavaScript y no engorda el grafo inicial de Hoy.
 */
export const load: PageServerLoad = async ({ locals, params, url, depends }) => {
  depends('cc:employment');
  const overview = locals.user
    ? await loadEmploymentOverview({ id: locals.user.id }, params.householdId)
    : null;
  return {
    householdId: params.householdId,
    terms: overview?.terms ?? null,
    agreement: overview?.agreement ?? null,
    // El historial de versiones que el Resumen ya no enseña: aquí, con la voz
    // de quien lee su propio contrato. La RLS ya recortó lo que no toca.
    versions: overview?.versions ?? [],
    empleada: url.searchParams.get('empleada')
  };
};
