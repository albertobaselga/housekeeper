/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

const STATIC_CACHE = `casa-clara-static-${version}`;
const PAGE_CACHE = `casa-clara-pages-${version}`;
const PRECACHE = [...build, ...files];

/**
 * Header de calentamiento: un `fetch` de página con este header se guarda en
 * PAGE_CACHE bajo su URL limpia, como si hubiera sido una navegación completa.
 * Lo usa el layout del hogar para dejar Emergencias disponible offline sin
 * exigir una visita previa (UX-P1-5 / I-03).
 */
const WARM_HEADER = 'x-casa-clara-warm-page';

/**
 * ¿Puede esta respuesta sustituir en la caché a la que ya hay guardada?
 *
 * Una página que se declara `no-store` NO puede. La usa Emergencias cuando el
 * servidor no ha podido leer los contactos del hogar: responde 200 a propósito
 * —esa pantalla no puede caerse— pero su contenido es «no podemos leerlos», y
 * guardarlo encima borraría la última copia que sí traía los teléfonos, que es
 * lo único que quedaría para una urgencia sin cobertura.
 */
function storable(response: Response): boolean {
  return response.ok && !(response.headers.get('cache-control') ?? '').includes('no-store');
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const staticCache = await caches.open(STATIC_CACHE);
    await staticCache.addAll(PRECACHE);
    try {
      const offlineResponse = await fetch('/offline');
      if (offlineResponse.ok) {
        const pageCache = await caches.open(PAGE_CACHE);
        await pageCache.put('/offline', offlineResponse);
      }
    } catch {
      // The first install needs a network anyway; a later online visit can cache
      // the fallback without invalidating the already cached static shell.
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => ![STATIC_CACHE, PAGE_CACHE].includes(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const pageCache = await caches.open(PAGE_CACHE);
      // ignoreVary: las páginas calentadas se guardan bajo su URL limpia y la
      // petición de navegación real no debe fallar por un header `Vary`.
      const fromCache = async () =>
        (await pageCache.match(request, { ignoreVary: true }))
          ?? (await pageCache.match('/offline', { ignoreVary: true }))
          ?? new Response('Sin conexión', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      try {
        const response = await fetch(request);
        if (response.ok) {
          if (storable(response)) await pageCache.put(request, response.clone());
          return response;
        }
        // 503 = el servidor está en pie pero no ha podido leer los datos de la
        // casa. Para quien mira la pantalla es indistinguible de no tener red,
        // y hay una respuesta mejor que un error: lo último que se guardó en
        // este dispositivo, que la propia página etiqueta como guardado y con
        // su fecha. Solo el 503; un 403 o un 404 son respuestas con sentido y
        // se dejan pasar tal cual.
        if (response.status === 503) return await fromCache();
        return response;
      } catch {
        return await fromCache();
      }
    })());
    return;
  }

  if (request.headers.get(WARM_HEADER) === '1') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (storable(response)) {
          const pageCache = await caches.open(PAGE_CACHE);
          // La clave es la URL sin headers: idéntica a la que buscará el
          // fallback de navegación cuando no haya red.
          await pageCache.put(new URL(request.url).pathname, response.clone());
        }
        return response;
      } catch {
        return new Response('Sin conexión', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
    return;
  }

  // El HTML de SvelteKit referencia sus assets con rutas RELATIVAS: cuando el
  // fallback /offline se sirve bajo otra URL (p. ej. /h/<id>/contacts), el
  // navegador pide /h/<id>/_app/… y los assets precacheados no coincidirían.
  // Se normaliza al sufijo /_app/… para que la página offline hidrate sin red.
  const appIndex = url.pathname.indexOf('/_app/');
  if (appIndex > 0) {
    const normalized = url.pathname.slice(appIndex);
    if (PRECACHE.includes(normalized)) {
      event.respondWith(
        caches.match(normalized).then((cached) => cached ?? fetch(request))
      );
    }
  }
});
