import { loadEmploymentOverview } from '$lib/server/employment.server';
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
export const load: PageServerLoad = async ({ locals, params, url, depends }) => {
  depends('cc:vacations');
  // También del token de empleo: apuntar o anular días desde la tarjeta del
  // año invalida 'cc:employment', y el saldo de esta página debe refrescarse.
  depends('cc:employment');
  // La empleada elegida viaja en la URL por toda la sección: decide de quién
  // es la tarjeta del año, el orden del historial (la elegida primero) y el
  // enlace de vuelta de las pestañas.
  const empleada = url.searchParams.get('empleada');
  const [overview, employment] = locals.user
    ? await Promise.all([
        loadVacationOverview({ id: locals.user.id }, params.householdId),
        // El expediente trae el saldo del año y el acuerdo al que apuntar
        // días: es lo que la tarjeta de vacaciones necesita para escribir.
        loadEmploymentOverview(
          { id: locals.user.id },
          params.householdId,
          undefined,
          undefined,
          empleada
        )
      ])
    : [null, null];
  return { overview, employment, householdId: params.householdId, empleada };
};
