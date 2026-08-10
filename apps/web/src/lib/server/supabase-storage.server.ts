/**
 * Almacén de adjuntos sobre **Supabase Storage por su API REST**, con la clave
 * de servicio del proyecto.
 *
 * Por qué esta y no la compatibilidad S3 del mismo Storage:
 *
 * - La clave de servicio YA EXISTE en cualquier proyecto de Supabase: solo hay
 *   que copiarla del panel. Las credenciales S3 hay que CREARLAS a mano, y cada
 *   paso manual que se le pide al propietario es un paso que puede quedarse sin
 *   dar, o darse a medias.
 * - El bucket también se puede crear desde aquí (`ensureBucket`), privado y con
 *   sus límites, así que no hace falta pasar por el panel para eso tampoco.
 * - Son tres llamadas HTTP con `fetch`: no arrastra el SDK de S3 al arranque en
 *   frío de una función serverless, que en Vercel se paga en cada invocación.
 *
 * Lo que NO cambia: los objetos siguen siendo privados. La clave de servicio se
 * queda en el servidor, nunca se firma una URL pública y la lectura sigue
 * pasando por la ruta autenticada, que comprueba sesión y pertenencia con RLS.
 * Esta clave salta la RLS de Storage, así que el control de acceso real es el
 * de `app.storage_objects` y `app.documents`, no el del bucket.
 */

import { createLogger } from '@casa-clara/server';

import { ALLOWED_ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES } from './attachments.server';

const log = createLogger('web:supabase-storage');

export interface SupabaseStorageConfig {
  /** Raíz del proyecto, p. ej. `https://abcdefgh.supabase.co`. */
  url: string;
  /** Clave de servicio (`service_role` clásica o `sb_secret_…` nueva). */
  serviceKey: string;
  bucket: string;
}

/**
 * Deduce la raíz del proyecto a partir de la cadena de conexión de Postgres,
 * para no obligar al propietario a copiar del panel dos cosas cuando una basta.
 * Reconoce las dos formas que da Supabase:
 *
 *   - conexión directa   `db.<ref>.supabase.co`
 *   - pooler             usuario `postgres.<ref>` en `*.pooler.supabase.com`
 *
 * Devuelve null si no reconoce la forma; entonces manda SUPABASE_URL, que
 * siempre tiene prioridad sobre lo deducido.
 */
export function supabaseUrlFromDatabaseUrl(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return null;
  }
  const direct = /^db\.([a-z0-9]{16,})\.supabase\.(co|com)$/i.exec(parsed.hostname);
  if (direct) return `https://${direct[1]}.supabase.co`;
  if (/\.pooler\.supabase\.(com|co)$/i.test(parsed.hostname)) {
    const pooled = /^postgres\.([a-z0-9]{16,})$/i.exec(decodeURIComponent(parsed.username));
    if (pooled) return `https://${pooled[1]}.supabase.co`;
  }
  return null;
}

/** Lee la configuración del entorno; null si falta lo imprescindible. */
export function readSupabaseStorageConfig(
  environment: Partial<Record<string, string>>
): SupabaseStorageConfig | null {
  const serviceKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim() || environment.SUPABASE_SECRET_KEY?.trim();
  if (!serviceKey) return null;
  const declaredUrl = environment.SUPABASE_URL?.trim();
  const url = (declaredUrl || supabaseUrlFromDatabaseUrl(environment.DATABASE_URL?.trim()) || '').replace(/\/+$/, '');
  if (!url) {
    // Hay clave pero no se sabe a qué proyecto apunta: una equivocación de
    // configuración, no una decisión. Se deja dicho en el registro en vez de
    // caer en silencio al camino S3 (que probablemente tampoco esté puesto).
    log.warn('supabase service key set but no project url could be resolved');
    return null;
  }
  const bucket = environment.SUPABASE_STORAGE_BUCKET?.trim() || environment.S3_PRIVATE_BUCKET?.trim() || 'casaclara';
  return { url, serviceKey, bucket };
}

/** Cada segmento se codifica por separado: las barras de la clave son ruta. */
function encodeObjectPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function authHeaders(config: SupabaseStorageConfig): Record<string, string> {
  // `apikey` cubre las claves nuevas (`sb_secret_…`) y `authorization` las
  // clásicas de tipo JWT; mandar las dos funciona en ambos regímenes.
  return { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` };
}

/**
 * Cuerpo de error de Storage, recortado. Nunca se propaga al navegador: la ruta
 * responde un 503 genérico y esto va al registro del servidor, donde hace falta
 * para distinguir «bucket que no existe» de «clave caducada».
 */
async function describeFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 300);
  } catch {
    detail = '(sin cuerpo)';
  }
  return `${response.status} ${response.statusText}: ${detail}`;
}

/**
 * Crea el bucket PRIVADO si no existe. Idempotente: un 409 («ya existe») es
 * éxito. Se llama solo cuando una subida ha fallado por bucket inexistente, de
 * modo que el camino normal son dos llamadas HTTP y no tres.
 */
export async function ensureBucket(config: SupabaseStorageConfig, fetchFn: typeof fetch = fetch): Promise<void> {
  const response = await fetchFn(`${config.url}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...authHeaders(config), 'content-type': 'application/json' },
    body: JSON.stringify({
      id: config.bucket,
      name: config.bucket,
      // Lo importante de esta llamada. Un bucket público dejaría los
      // justificantes del hogar accesibles a quien adivine la clave.
      public: false,
      // Los mismos límites que aplica la tubería, repetidos en el bucket como
      // segunda línea. OJO al acoplamiento: se fijan al CREARLO, así que si
      // algún día se admite un tipo nuevo hay que ampliarlos también en el
      // panel de Supabase (queda dicho en el runbook, §3.1).
      file_size_limit: MAX_ATTACHMENT_BYTES,
      allowed_mime_types: Object.keys(ALLOWED_ATTACHMENT_TYPES)
    })
  });
  if (response.ok || response.status === 409) {
    void response.body?.cancel();
    return;
  }
  throw new Error(`Supabase Storage no pudo crear el bucket ${config.bucket}: ${await describeFailure(response)}`);
}

/** ¿El fallo del PUT es «ese bucket no existe» y no otra cosa? */
async function isMissingBucket(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 404) return false;
  let body = '';
  try {
    body = await response.text();
  } catch {
    return false;
  }
  return /bucket not found/i.test(body);
}

export interface SupabaseStorageClient {
  bucket: string;
  putObject(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  getObject(key: string): Promise<Uint8Array>;
  getObjectStream(key: string): Promise<ReadableStream<Uint8Array>>;
}

export function createSupabaseStorageClient(
  config: SupabaseStorageConfig,
  fetchFn: typeof fetch = fetch
): SupabaseStorageClient {
  const objectUrl = (key: string): string =>
    `${config.url}/storage/v1/object/${encodeURIComponent(config.bucket)}/${encodeObjectPath(key)}`;

  const put = (key: string, bytes: Uint8Array, contentType: string): Promise<Response> =>
    fetchFn(objectUrl(key), {
      method: 'POST',
      headers: {
        ...authHeaders(config),
        'content-type': contentType,
        // La clave es determinista (sha-256 del contenido), así que reescribir
        // es escribir exactamente los mismos bytes: `x-upsert` evita que un
        // reintento tras un corte muera con un 409 espurio.
        'x-upsert': 'true'
        // Sin `cache-control`: el bucket es privado y los bytes solo salen por
        // nuestra ruta, que ya responde `private, no-store`. Lo que Storage
        // guarde como metadato de caché no lo ve nadie.
      },
      body: bytes as unknown as BodyInit
    });

  const fetchObject = async (key: string): Promise<Response> => {
    const response = await fetchFn(objectUrl(key), { headers: authHeaders(config) });
    if (!response.ok) {
      throw new Error(`Supabase Storage no devolvió el objeto ${key}: ${await describeFailure(response)}`);
    }
    return response;
  };

  return {
    bucket: config.bucket,
    putObject: async (key, bytes, contentType) => {
      let response = await put(key, bytes, contentType);
      if (!response.ok && (await isMissingBucket(response))) {
        // Primera subida del despliegue: el bucket todavía no existe. Se crea
        // aquí, privado, y se reintenta UNA vez. Así el propietario no tiene
        // que crear nada en el panel.
        log.info('creating private bucket on first upload');
        await ensureBucket(config, fetchFn);
        response = await put(key, bytes, contentType);
      }
      if (!response.ok) {
        // Al registro va solo el status: el cuerpo de Storage puede arrastrar la
        // clave del objeto, que lleva el identificador del hogar.
        log.error('supabase storage put failed', { status: response.status });
        throw new Error(`Supabase Storage rechazó el objeto ${key}: ${await describeFailure(response)}`);
      }
      void response.body?.cancel();
    },
    getObject: async (key) => new Uint8Array(await (await fetchObject(key)).arrayBuffer()),
    getObjectStream: async (key) => {
      const response = await fetchObject(key);
      if (!response.body) throw new Error(`El objeto ${key} llegó sin contenido`);
      return response.body;
    }
  };
}
