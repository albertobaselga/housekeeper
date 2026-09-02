import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * El reparto del `fetch` del service worker, ejercitado de verdad.
 *
 * El módulo se escribió para un ServiceWorkerGlobalScope, así que aquí se le
 * fabrica uno mínimo —`self`, `caches` y `fetch`— y se le entregan eventos a
 * mano. No hay navegador de por medio: lo que se comprueba es a QUÉ rama va
 * cada petición, que es donde estaba la avería.
 *
 * La avería: un enlace a un PDF (el recibo con `target="_blank"`, el documento
 * de pago con `download`) es para el navegador una NAVEGACIÓN, y la rama de
 * navegación cambia todo 503 por la página «Sin conexión». 503 es justo el
 * código de los fallos honestos de esos dos endpoints —el desajuste de almacén
 * entre otros—, así que la persona veía «Sin conexión» teniendo conexión y el
 * motivo real se perdía.
 */

vi.mock('$service-worker', () => ({ build: [], files: [], version: 'test' }));

const ORIGIN = 'https://casa.example';

class FakeCache {
  readonly entries = new Map<string, Response>();

  private key(request: Request | string): string {
    return new URL(typeof request === 'string' ? request : request.url, ORIGIN).pathname;
  }

  async match(request: Request | string): Promise<Response | undefined> {
    return this.entries.get(this.key(request));
  }

  async put(request: Request | string, response: Response): Promise<void> {
    this.entries.set(this.key(request), response);
  }

  async addAll(): Promise<void> {}
}

/** Las cachés abiertas, por nombre: el almacén detrás del `caches` global. */
const almacen = new Map<string, FakeCache>();

function cacheNamed(name: string): FakeCache {
  const existing = almacen.get(name);
  if (existing) return existing;
  const created = new FakeCache();
  almacen.set(name, created);
  return created;
}

/** La caché de páginas, con el nombre que le da la `version` del mock. */
const pageCache = () => cacheNamed('housekeeper-pages-test');

/** Una petición como la que llega al worker, sin pasar por `new Request`. */
function petition(
  path: string,
  { mode = 'no-cors', headers = {}, method = 'GET' } = {} as {
    mode?: string;
    headers?: Record<string, string>;
    method?: string;
  }
): Request {
  return {
    method,
    mode,
    url: new URL(path, ORIGIN).toString(),
    headers: new Headers(headers)
  } as unknown as Request;
}

type FetchEvent = { request: Request; respondWith: (response: Promise<Response>) => void };
let onFetch: (event: FetchEvent) => void;
let network: ReturnType<typeof vi.fn>;

/**
 * Entrega el evento y devuelve lo que el worker decidió: `null` cuando NO
 * intercepta (que es lo que debe pasar con la API) y la promesa de respuesta
 * cuando sí.
 */
function dispatch(request: Request): Promise<Response> | null {
  let answered: Promise<Response> | null = null;
  onFetch({ request, respondWith: (response) => { answered = response; } });
  return answered;
}

beforeAll(async () => {
  const listeners = new Map<string, (event: never) => void>();
  vi.stubGlobal('self', {
    addEventListener: (type: string, handler: (event: never) => void) => listeners.set(type, handler),
    location: new URL(ORIGIN),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    registration: {}
  });
  vi.stubGlobal('caches', {
    open: async (name: string) => cacheNamed(name),
    match: async () => undefined
  });
  network = vi.fn();
  vi.stubGlobal('fetch', network);

  await import('../src/service-worker');
  onFetch = listeners.get('fetch') as unknown as (event: FetchEvent) => void;
  expect(onFetch, 'el worker registra su manejador de fetch').toBeTypeOf('function');
});

beforeEach(() => {
  network.mockReset();
  almacen.clear();
});

describe('la API se sirve tal cual, sin caché ni página de respaldo', () => {
  it('un PDF abierto en pestaña nueva (navegación) no lo toca el worker', () => {
    // El recibo archivado: `<a target="_blank">` ⇒ `mode: 'navigate'`.
    const receipt = petition('/api/v1/households/h1/settlements/s1/receipt', { mode: 'navigate' });
    expect(dispatch(receipt)).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });

  it('el documento de pago descargable tampoco', () => {
    // El hermano que dibuja el PDF al momento: `<a download>` ⇒ navegación.
    const document = petition('/api/v1/households/h1/settlements/s1/documento', { mode: 'navigate' });
    expect(dispatch(document)).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });

  it('ni las llamadas normales de la aplicación a la API', () => {
    expect(dispatch(petition('/api/v1/sync'))).toBeNull();
    expect(dispatch(petition('/api/health'))).toBeNull();
  });
});

describe('las páginas conservan su respaldo sin red', () => {
  it('un 503 de una página sí cae a la última copia guardada', async () => {
    const page = petition('/h/h1/employment/pagos', { mode: 'navigate' });
    await pageCache().put(page, new Response('la copia de ayer'));
    network.mockResolvedValue(new Response('no podemos leer', { status: 503 }));

    const answered = dispatch(page);
    expect(answered, 'la página SÍ se intercepta').not.toBeNull();
    expect(await (await answered!).text()).toBe('la copia de ayer');
  });

  it('una ruta nunca visitada cae al aviso offline', async () => {
    await pageCache().put('/offline', new Response('Sin conexión'));
    network.mockRejectedValue(new Error('sin red'));

    const answered = dispatch(petition('/h/h1/recipes', { mode: 'navigate' }));
    expect(await (await answered!).text()).toBe('Sin conexión');
  });

  it('una respuesta buena se guarda y se devuelve', async () => {
    const page = petition('/h/h1/emergency', { mode: 'navigate' });
    network.mockResolvedValue(new Response('los teléfonos'));

    const answered = await dispatch(page)!;
    expect(await answered.text()).toBe('los teléfonos');
    expect(await (await pageCache().match(page))!.text()).toBe('los teléfonos');
  });
});

describe('el precalentamiento de Emergencias sigue en pie', () => {
  it('guarda la página bajo su URL limpia, que es la que buscará la navegación', async () => {
    network.mockResolvedValue(new Response('los teléfonos'));
    const warm = petition('/h/h1/emergency', { headers: { 'x-housekeeper-warm-page': '1' } });

    const answered = await dispatch(warm)!;
    expect(await answered.text()).toBe('los teléfonos');
    expect(pageCache().entries.has('/h/h1/emergency')).toBe(true);
  });
});
