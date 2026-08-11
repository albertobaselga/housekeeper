import { error, json } from '@sveltejs/kit';

import type { CalendarWindow } from '$lib/calendar/view';
import { loadCalendar } from '$lib/server/calendar.server';
import type { RequestHandler } from './$types';

/**
 * Una VENTANA del calendario: los eventos del calendario enlazado y la autoría
 * de lo marcado alrededor de un día. Es lo único que el navegador no puede
 * calcular por su cuenta —las rutinas sí, a partir de sus reglas—.
 *
 * Existe como endpoint y no como navegación por una razón concreta y medida:
 * al cambiar de mes con `goto`, si la red está caída SvelteKit termina haciendo
 * una navegación completa, el service worker no tiene esa URL guardada y quien
 * miraba el calendario acaba en la página de «sin conexión», habiendo perdido
 * incluso las rutinas que su propio navegador acababa de calcular. Y no basta
 * con mirar `navigator.onLine` antes de saltar: esa propiedad sigue diciendo
 * `true` con la red caída en más casos de los que parece (un portal cautivo,
 * una wifi asociada sin salida, y también la emulación de Playwright, que es
 * como se cazó esto). Con un `fetch` que puede fallar sin consecuencias, la
 * pantalla se queda donde está y la banda explica qué falta.
 *
 * La RLS es la misma que la de la página: se reutiliza `loadCalendar` entero,
 * de modo que no hay un segundo sitio donde se pueda olvidar quién ve qué.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  if (!locals.user.householdIds.includes(params.householdId)) error(404, 'Hogar no encontrado');

  const live = await loadCalendar({ id: locals.user.id }, params.householdId, {
    anchor: url.searchParams.get('d')
  });
  if (!live) error(503, 'No se ha podido leer el calendario del hogar');

  return json(
    {
      windowFromISO: live.windowFromISO,
      windowToISO: live.windowToISO,
      events: live.events,
      completions: live.completions,
      eventDaysYear: live.eventDaysYear,
      eventDaysISO: live.eventDaysISO
    } satisfies CalendarWindow,
    { headers: { 'cache-control': 'no-store' } }
  );
};
