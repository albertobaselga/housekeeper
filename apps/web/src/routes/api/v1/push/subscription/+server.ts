import { error, json } from '@sveltejs/kit';

import { endpointIsAcceptable, forgetOwnDevice, saveOwnDevice } from '$lib/server/push.server';
import type { RequestHandler } from './$types';

/**
 * Encender y apagar los avisos de ESTE dispositivo.
 *
 * Sin hogar en la ruta, y no es un descuido: un teléfono no pertenece a un
 * hogar, pertenece a quien lo lleva encima. Poner el hogar en la URL sugeriría
 * que la casa tiene algo que decir sobre el aparato de alguien, y no lo tiene.
 * El hogar entra después, cuando la base decide a quién enviar cada aviso.
 *
 * No acepta —ni podría aceptar— un identificador de persona: la RLS de la 0032
 * ata cada fila a `app.current_user_id()` en lectura y en escritura. Suscribir el
 * teléfono de otra persona no es algo que este endpoint rechace: es algo que no
 * se puede expresar por ningún cuerpo de petición.
 */

interface SubscriptionBody {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
  deviceLabel?: unknown;
}

function sameOrigin(request: Request, expected: URL): void {
  const origin = request.headers.get('origin');
  // Mismo criterio que /api/v1/sync: estas rutas no llevan formulario, así que
  // la protección CSRF de SvelteKit no las cubre y el origen se comprueba aquí.
  if (origin && origin !== expected.origin) error(403, 'Origen no permitido');
}

async function readSubscription(request: Request): Promise<SubscriptionBody> {
  try {
    return (await request.json()) as SubscriptionBody;
  } catch {
    error(400, 'Cuerpo ilegible');
  }
}

function requireString(value: unknown, max: number, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    error(400, message);
  }
  return value;
}

export const POST: RequestHandler = async ({ locals, request, url }) => {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  sameOrigin(request, url);

  const body = await readSubscription(request);
  const endpoint = requireString(body.endpoint, 2048, 'Falta la dirección del servicio de avisos');
  const p256dh = requireString(body.keys?.p256dh, 255, 'Falta la clave del dispositivo');
  const auth = requireString(body.keys?.auth, 255, 'Falta el secreto del dispositivo');
  const rawLabel = body.deviceLabel;
  const deviceLabel =
    typeof rawLabel === 'string' && rawLabel.trim().length > 0 ? rawLabel.trim().slice(0, 80) : null;

  // El endpoint lo elige el navegador, pero llega por una petición que cualquiera
  // de las cinco personas del hogar puede fabricar a mano. Sin este veto, el
  // servidor haría POST a donde le dijeran: mismo criterio anti-SSRF que las
  // fuentes de calendario, y el mismo comprobador.
  if (!(await endpointIsAcceptable(endpoint))) {
    error(422, 'Esa dirección de avisos no es válida');
  }

  if (!(await saveOwnDevice({ id: locals.user.id }, { endpoint, p256dh, auth, deviceLabel }))) {
    error(503, 'No hemos podido guardar los avisos de este dispositivo');
  }
  return json({ subscribed: true }, { headers: { 'cache-control': 'no-store' } });
};

export const DELETE: RequestHandler = async ({ locals, request, url }) => {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  sameOrigin(request, url);

  const body = await readSubscription(request);
  const endpoint = requireString(body.endpoint, 2048, 'Falta la dirección del servicio de avisos');

  // Sin veto anti-SSRF al borrar: aquí no se contacta con nadie, solo se busca
  // una fila propia. Un endpoint que no sea suyo no borra nada y responde igual,
  // que es justamente lo que debe hacer.
  if (!(await forgetOwnDevice({ id: locals.user.id }, endpoint))) {
    error(503, 'No hemos podido apagar los avisos de este dispositivo');
  }
  return json({ subscribed: false }, { headers: { 'cache-control': 'no-store' } });
};
