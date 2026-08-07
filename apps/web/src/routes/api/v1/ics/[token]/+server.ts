import { error } from '@sveltejs/kit';

import type { RequestHandler } from './$types';

/**
 * Feed ICS público por token (sin sesión): el cliente de calendario presenta el
 * token opaco en la URL y el servidor debería localizar el feed no revocado por
 * su sha-256 y emitir las próximas ocurrencias de rutinas según su audiencia.
 *
 * HUECO DE ESQUEMA (documentado para la migración 0009): con el esquema
 * congelado esta ruta NO puede emitir el feed. `app.ics_feeds` y `app.routines`
 * están bajo RLS forzada y solo son visibles con contexto de usuario/hogar
 * (`app.user_id` + `app.set_household_context`), que aquí no existe porque la
 * petición es anónima por diseño. Ni siquiera la búsqueda del feed por
 * `token_hash` es posible: el pool de la aplicación ve cero filas sin contexto,
 * y para fijar el contexto del creador habría que leer antes el propio feed.
 * La 0009 añadirá una función SECURITY DEFINER de alcance mínimo (token_hash →
 * feed vigente + rutinas de su audiencia) y esta ruta pasará a usarla.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

export const GET: RequestHandler = ({ params }) => {
  if (!TOKEN_PATTERN.test(params.token)) {
    error(404, 'Feed no encontrado');
  }

  return new Response(
    'La emisión del feed ICS requiere la función de acceso de la migración 0009; pendiente de integración.\n',
    {
      status: 503,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': '86400'
      }
    }
  );
};
