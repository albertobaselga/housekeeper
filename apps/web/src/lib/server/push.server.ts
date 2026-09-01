/**
 * Los dispositivos a los que una persona ha pedido que se le avise.
 *
 * Es la única parte de la aplicación que escribe en `app.push_subscriptions`, y
 * la única que puede: la RLS de la 0032 deja ver y tocar exclusivamente las
 * filas propias, así que **no hay ningún parámetro de «a quién»** en ninguna de
 * estas funciones. No es que se rechace suscribir a otra persona: es que no se
 * puede expresar. Ni siquiera quien administra el hogar.
 *
 * El contexto que se fija es solo `app.user_id`, sin hogar — mismo camino que
 * `resolveAppUser`—, porque un teléfono no pertenece a un hogar: pertenece a
 * quien lo lleva encima. El hogar entra después, al decidir a quién enviar, y lo
 * decide la base.
 */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

import type { Pool } from 'pg';

import { env } from '$env/dynamic/private';
import { createLogger } from '@housekeeper/server';
import { isForbiddenAddress } from '@housekeeper/worker/net';
import { loadVapidConfig } from '@housekeeper/worker/push-channel';

import { unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';

const log = createLogger('web:push');

/** Lo que el navegador devuelve al suscribirse, ya validado. */
export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceLabel: string | null;
}

/** Lo que ve su dueña —y solo ella— en «Tu cuenta». */
export interface PushDeviceView {
  id: string;
  endpoint: string;
  deviceLabel: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  failureCount: number;
}

/**
 * La clave pública VAPID que necesita el navegador para suscribirse.
 *
 * Pública de verdad: identifica al servidor ante el servicio de push y viaja al
 * cliente por definición. La privada NUNCA sale de aquí y no se expone por
 * ninguna ruta. Que esta función devuelva `null` es la señal de que en esta
 * instalación no hay canal, y la interfaz lo dice en vez de ofrecer un
 * interruptor que no puede funcionar.
 *
 * El «¿hay canal?» lo decide `loadVapidConfig` y NO una comprobación propia de
 * esta mitad, que es lo que había antes: aquí bastaba con que las tres cadenas
 * no estuvieran vacías, mientras el worker exigía además que el `sub` tuviera la
 * forma de la norma. Con esa diferencia, un `VAPID_SUBJECT` sucio dibujaba el
 * interruptor y dejaba suscribirse a una casa a la que la cola nunca iba a
 * mandar nada. La respuesta tiene que ser la misma en las dos mitades o el
 * canal miente.
 */
export function pushPublicKey(
  environment: Partial<Record<string, string>> = env
): string | null {
  return loadVapidConfig(environment)?.publicKey ?? null;
}

/**
 * Veto anti-SSRF sobre el endpoint que manda el navegador.
 *
 * Sin esto, cualquiera de las cinco personas del hogar podría hacer que el
 * servidor mandara peticiones POST a una dirección de la red interna sin más
 * que registrar un «dispositivo» inventado. Se aplica el MISMO criterio que a
 * las fuentes ICS —solo https, sin credenciales embebidas, y el host tiene que
 * resolver íntegramente a direcciones públicas—, reutilizando su comprobador en
 * vez de escribir un segundo criterio que se desviaría del primero.
 *
 * Falla cerrado: un host que no resuelve no se guarda.
 */
export async function endpointIsAcceptable(
  rawEndpoint: string,
  resolve: (hostname: string) => Promise<Array<{ address: string }>> = (hostname) =>
    lookup(hostname, { all: true })
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawEndpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (rawEndpoint.length > 2048) return false;

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  // Un literal IP tampoco pasa de largo: `lookup` también los resuelve, así que
  // se comprueban por el mismo camino.
  if (isIP(hostname) === 0 && hostname.length === 0) return false;
  try {
    const addresses = await resolve(hostname);
    if (addresses.length === 0) return false;
    return !addresses.some(({ address }) => isForbiddenAddress(address));
  } catch {
    return false;
  }
}

async function withOwnIdentity<T>(
  userId: string,
  operation: (client: import('pg').PoolClient) => Promise<T>,
  pool: Pool | null = getDatabasePool()
): Promise<T | null> {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.user_id', $1, true)", [userId]);
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (cause) {
    await client.query('rollback').catch(() => {});
    return unreadable(log, 'push subscriptions', cause);
  } finally {
    client.release();
  }
}

/**
 * Guarda (o revive) el dispositivo de quien lo pide.
 *
 * `on conflict (endpoint)` porque el endpoint es lo que devuelve el navegador y
 * re-suscribir el mismo aparato produce el mismo valor: tiene que actualizar la
 * fila, no duplicarla. Y limpia `revoked_at` y `failure_count`, que es lo que
 * convierte «volver a encenderlos» en algo que de verdad funciona después de que
 * el navegador matara la suscripción anterior.
 *
 * Si el endpoint fuese de otra persona, la RLS impide el UPDATE y la operación
 * se cae. Es un caso que no puede ocurrir —los servicios de push no reparten dos
 * veces el mismo endpoint— y que, si ocurriera, tiene que fallar y no escribir.
 */
export async function saveOwnDevice(
  principal: { id: string },
  input: PushSubscriptionInput,
  pool: Pool | null = getDatabasePool()
): Promise<boolean> {
  const stored = await withOwnIdentity(
    principal.id,
    async (client) => {
      await client.query(
        `insert into app.push_subscriptions (user_id, endpoint, p256dh, auth, device_label)
         values ($1, $2, $3, $4, $5)
         on conflict (endpoint) do update
            set p256dh = excluded.p256dh,
                auth = excluded.auth,
                device_label = coalesce(excluded.device_label, app.push_subscriptions.device_label),
                last_seen_at = statement_timestamp(),
                failure_count = 0,
                revoked_at = null`,
        [principal.id, input.endpoint, input.p256dh, input.auth, input.deviceLabel]
      );
      return true;
    },
    pool
  );
  return stored === true;
}

/**
 * Apaga los avisos de un dispositivo.
 *
 * Borra la fila en vez de marcarla revocada, y la diferencia importa: apagar los
 * avisos es una decisión de la persona, no una avería, y no tiene por qué dejar
 * rastro de cuándo la tomó. `revoked_at` es para lo otro —el endpoint que el
 * servicio de push dio por muerto—, donde la fecha es lo único que permite
 * explicar el silencio.
 */
export async function forgetOwnDevice(
  principal: { id: string },
  endpoint: string,
  pool: Pool | null = getDatabasePool()
): Promise<boolean> {
  const deleted = await withOwnIdentity(
    principal.id,
    async (client) => {
      await client.query('delete from app.push_subscriptions where endpoint = $1', [endpoint]);
      return true;
    },
    pool
  );
  return deleted === true;
}

/** Los dispositivos de quien pregunta. De nadie más: lo impone la RLS. */
export async function listOwnDevices(
  principal: { id: string },
  pool: Pool | null = getDatabasePool()
): Promise<PushDeviceView[]> {
  const devices = await withOwnIdentity(
    principal.id,
    async (client) => {
      const result = await client.query<{
        id: string;
        endpoint: string;
        device_label: string | null;
        created_at: string;
        last_success_at: string | null;
        failure_count: number;
      }>(
        `select id, endpoint, device_label,
                created_at::text as created_at,
                last_success_at::text as last_success_at,
                failure_count
           from app.push_subscriptions
          where revoked_at is null
          order by created_at`
      );
      return result.rows.map((row) => ({
        id: row.id,
        endpoint: row.endpoint,
        deviceLabel: row.device_label,
        createdAt: row.created_at,
        lastSuccessAt: row.last_success_at,
        failureCount: row.failure_count
      }));
    },
    pool
  );
  return devices ?? [];
}
