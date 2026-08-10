import { describe, expect, it, vi } from 'vitest';

import {
  createSupabaseStorageClient,
  readSupabaseStorageConfig,
  supabaseUrlFromDatabaseUrl
} from '../src/lib/server/supabase-storage.server';

/**
 * Almacén de justificantes sobre Supabase Storage por su API REST. Lo que se
 * fija aquí es lo que no puede fallar en producción: que el bucket nazca
 * PRIVADO, que la clave de servicio no se filtre a una URL, que las claves con
 * barras viajen como ruta y que un fallo del almacén sea un fallo, no un
 * silencio.
 */

const CONFIG = {
  url: 'https://proyectosintetico00.supabase.co',
  serviceKey: 'clave-de-servicio-sintetica',
  bucket: 'casaclara'
};
const KEY = '11111111-1111-4111-8111-111111111111/attachments/abcdef0123456789.jpg';
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);

function ok(body: BodyInit = '', status = 200): Response {
  return new Response(body, { status });
}

describe('de dónde sale la raíz del proyecto', () => {
  it('la deduce de la conexión directa de Postgres', () => {
    expect(supabaseUrlFromDatabaseUrl('postgresql://u:p@db.abcdefghijklmnop.supabase.co:5432/postgres')).toBe(
      'https://abcdefghijklmnop.supabase.co'
    );
  });

  it('la deduce también del pooler, donde la referencia va en el usuario', () => {
    expect(
      supabaseUrlFromDatabaseUrl('postgresql://postgres.abcdefghijklmnop:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres')
    ).toBe('https://abcdefghijklmnop.supabase.co');
  });

  it('no se inventa nada con una base que no es de Supabase', () => {
    expect(supabaseUrlFromDatabaseUrl('postgresql://casa@127.0.0.1:5432/casaclara')).toBeNull();
    expect(supabaseUrlFromDatabaseUrl('esto no es una URL')).toBeNull();
    expect(supabaseUrlFromDatabaseUrl(undefined)).toBeNull();
  });

  it('SUPABASE_URL declarada manda sobre la deducida', () => {
    const config = readSupabaseStorageConfig({
      SUPABASE_URL: 'https://otroproyecto00000.supabase.co/',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
      DATABASE_URL: 'postgresql://u:p@db.abcdefghijklmnop.supabase.co:5432/postgres'
    });
    // La barra final se recorta: si no, las URL saldrían con doble barra.
    expect(config?.url).toBe('https://otroproyecto00000.supabase.co');
  });

  it('sin clave de servicio no hay configuración, por muy buena que sea la URL', () => {
    expect(readSupabaseStorageConfig({ SUPABASE_URL: CONFIG.url })).toBeNull();
  });

  it('acepta el nombre nuevo de la clave secreta', () => {
    expect(readSupabaseStorageConfig({ SUPABASE_URL: CONFIG.url, SUPABASE_SECRET_KEY: 'sb_secret_x' })?.serviceKey).toBe(
      'sb_secret_x'
    );
  });

  it('el bucket por omisión es casaclara y S3_PRIVATE_BUCKET sirve de alias', () => {
    expect(readSupabaseStorageConfig({ SUPABASE_URL: CONFIG.url, SUPABASE_SECRET_KEY: 'k' })?.bucket).toBe('casaclara');
    expect(
      readSupabaseStorageConfig({ SUPABASE_URL: CONFIG.url, SUPABASE_SECRET_KEY: 'k', S3_PRIVATE_BUCKET: 'otro' })
        ?.bucket
    ).toBe('otro');
  });
});

describe('subir un justificante', () => {
  it('va a la ruta del objeto, autenticado, y la clave NO viaja en la URL', async () => {
    const fetchFn = vi.fn(async () => ok('{"Key":"casaclara/x"}'));
    await createSupabaseStorageClient(CONFIG, fetchFn as unknown as typeof fetch).putObject(KEY, JPEG, 'image/jpeg');

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${CONFIG.url}/storage/v1/object/casaclara/${KEY}`);
    // Las barras de la clave son separadores de ruta, no texto codificado.
    expect(url).not.toContain('%2F');
    expect(url).not.toContain(CONFIG.serviceKey);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${CONFIG.serviceKey}`);
    expect(headers.apikey).toBe(CONFIG.serviceKey);
    expect(headers['content-type']).toBe('image/jpeg');
  });

  it('la primera subida crea el bucket PRIVADO y reintenta una vez', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.endsWith('/storage/v1/bucket')) return ok('{}');
      return calls.filter((call) => call.url.includes('/object/')).length === 1
        ? ok('{"error":"Bucket not found"}', 400)
        : ok('{"Key":"casaclara/x"}');
    });

    await createSupabaseStorageClient(CONFIG, fetchFn as unknown as typeof fetch).putObject(KEY, JPEG, 'image/jpeg');

    const creation = calls.find((call) => call.url.endsWith('/storage/v1/bucket'));
    expect(creation).toBeDefined();
    const body = JSON.parse(String(creation!.init.body)) as { public: boolean; allowed_mime_types: string[] };
    // Lo único que de verdad importa de esta llamada.
    expect(body.public).toBe(false);
    expect(body.allowed_mime_types).toContain('image/jpeg');
    expect(calls.filter((call) => call.url.includes('/object/'))).toHaveLength(2);
  });

  it('un 403 (clave caducada) NO se confunde con un bucket que falta: no se crea nada y falla', async () => {
    const fetchFn = vi.fn(async () => ok('{"error":"Invalid JWT"}', 403));
    await expect(
      createSupabaseStorageClient(CONFIG, fetchFn as unknown as typeof fetch).putObject(KEY, JPEG, 'image/jpeg')
    ).rejects.toThrow(/rechazó el objeto/);
    expect(
      (fetchFn.mock.calls as unknown as string[][]).every((call) => !String(call[0]).endsWith('/storage/v1/bucket'))
    ).toBe(true);
  });
});

describe('leer un justificante ya guardado', () => {
  it('devuelve los bytes y el flujo por la ruta autenticada', async () => {
    const fetchFn = vi.fn(async () => ok(JPEG));
    const client = createSupabaseStorageClient(CONFIG, fetchFn as unknown as typeof fetch);

    expect(Array.from(await client.getObject(KEY))).toEqual(Array.from(JPEG));
    const stream = await client.getObjectStream(KEY);
    expect(stream).toBeInstanceOf(ReadableStream);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${CONFIG.serviceKey}`);
  });

  it('un 404 del almacén es un error, no un fichero vacío', async () => {
    const fetchFn = vi.fn(async () => ok('{"error":"Object not found"}', 404));
    await expect(
      createSupabaseStorageClient(CONFIG, fetchFn as unknown as typeof fetch).getObject(KEY)
    ).rejects.toThrow(/no devolvió el objeto/);
  });
});
