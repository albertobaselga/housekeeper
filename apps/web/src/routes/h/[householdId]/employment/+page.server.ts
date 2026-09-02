import {
  employmentHrefBases,
  loadEmploymentOverview,
  loadEmploymentPortada
} from '$lib/server/employment.server';
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { getEmploymentFixture } from '$lib/server/fixtures.server';
import { membershipIn } from '$lib/auth/membership';
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
        selectedAgreementId,
        employmentHrefBases(locals.user, params.householdId, selectedAgreementId)
      )
    : null;
  // Primero la persona, luego su expediente: sin elección en la URL, la entrada
  // es la PORTADA del hogar. La empleada tiene un solo expediente —el suyo, y
  // eso lo decide la RLS— y aterriza directa en él; un índice de un elemento
  // sería un clic de peaje.
  //
  // La condición ya no cuenta filas. Contar filas acertaba con dos personas y
  // encerraba a la casa de una sola —o de ninguna—, que es el estado normal de
  // una instalación recién hecha: la portada sólo aparecía cuando ya había dos
  // empleadas, y el alta, que vive en la portada, era inalcanzable justo en la
  // casa que necesitaba dar de alta a la primera. Lo que decide si hay que
  // elegir persona no es cuántas hay, sino quién mira.
  //
  // La misma guarda que `employmentHrefBases`: algún llamante (y las pruebas de
  // averías) trae un usuario con sólo el identificador, sin membresías. Sin
  // lista no se sabe qué papel tiene, y lo prudente es tratarlo como a quien no
  // es la empleada: la portada se puede mirar, el expediente de otra no.
  const role =
    locals.user && Array.isArray(locals.user.memberships)
      ? membershipIn(locals.user, params.householdId)?.role
      : undefined;
  const esLaEmpleada = role === 'employee_live_in';
  if (overview && !selectedAgreementId && !esLaEmpleada && locals.user) {
    const portada = await loadEmploymentPortada({ id: locals.user.id }, params.householdId);
    if (portada) return { portada, overview: null, employment: null };
  }
  if (overview) return { portada: null, overview, employment: null };
  // Con base de datos configurada aquí no hay maqueta que servir: 503 honesto
  // y registrado (data-source.server.ts). Sin base, la demostración sigue.
  return demoOrUnavailable(() => ({ portada: null, overview: null, employment: getEmploymentFixture() }));
};
