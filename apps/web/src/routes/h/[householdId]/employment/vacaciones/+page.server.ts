import { loadVacationOverview } from '$lib/server/vacations.server';
import type { PageServerLoad } from './$types';

/**
 * Vacaciones: la sección de la empleada y el historial de la administración,
 * en la MISMA ruta.
 *
 * No son dos pantallas porque no son dos verdades: los periodos apuntados y los
 * días que quedan de cada año son los mismos mire quien mire. Lo único que
 * cambia es cuántas personas devuelve la consulta —la RLS decide eso, no este
 * código— y la voz con la que se escriben las frases.
 *
 * Ruta propia, con su propio trozo de JavaScript, que la pantalla de Hoy no
 * importa nunca. Y sin `load` que escriba nada: la aplicación se precarga al
 * pasar el ratón por encima de un enlace (`data-sveltekit-preload-data="hover"`
 * en app.html), así que marcar aquí «ya lo ha visto» daría por leídas unas
 * vacaciones que nadie llegó a abrir. Esa marca la manda la propia página,
 * cuando de verdad está delante.
 */
export const load: PageServerLoad = async ({ locals, params, depends }) => {
  depends('cc:vacations');
  const overview = locals.user
    ? await loadVacationOverview({ id: locals.user.id }, params.householdId)
    : null;
  return { overview };
};
