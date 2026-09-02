/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

const STATIC_CACHE = `housekeeper-static-${version}`;
const PAGE_CACHE = `housekeeper-pages-${version}`;
const PRECACHE = [...build, ...files];

/**
 * Header de calentamiento: un `fetch` de página con este header se guarda en
 * PAGE_CACHE bajo su URL limpia, como si hubiera sido una navegación completa.
 * Lo usa el layout del hogar para dejar Emergencias disponible offline sin
 * exigir una visita previa (UX-P1-5 / I-03).
 */
const WARM_HEADER = 'x-housekeeper-warm-page';

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

/**
 * Un aviso al móvil, dibujado tal cual lo mandó el servidor.
 *
 * Este manejador NO sale a la red, y es deliberado: el payload ya trae el título,
 * el cuerpo y el destino compuestos, así que no hay ninguna consulta que pueda
 * fallar, tardar o filtrar nada entre que llega el aviso y aparece en pantalla.
 *
 * Mostrar algo es obligatorio, no una elección de diseño: la suscripción se pidió
 * con `userVisibleOnly: true` y un service worker que recibe y calla hace que el
 * navegador enseñe una notificación genérica suya —o revoque la suscripción—.
 * Por eso, si el payload viniera ilegible, se enseña algo honesto en vez de
 * intentar tragárselo.
 */
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let notice: { title?: string; body?: string; url?: string; tag?: string } = {};
    try {
      notice = (event.data?.json() ?? {}) as typeof notice;
    } catch {
      // Payload que no es JSON: no debería ocurrir nunca, pero callarse no es
      // una opción que este canal permita.
    }
    await self.registration.showNotification(notice.title ?? 'Hogar', {
      body: notice.body ?? 'Hay algo que mirar en la aplicación.',
      // El icono lo resuelve el navegador desde el manifiesto; no se declara
      // aquí para no tener dos sitios donde mantenerlo.
      tag: notice.tag ?? 'housekeeper',
      // Sustituir en silencio: el mismo asunto avisado dos veces no vibra dos
      // veces. La escalada de la cuenta pendiente reutiliza su etiqueta a
      // propósito. El campo es del estándar y los navegadores lo respetan, pero
      // la lib.dom de TypeScript 6 dejó de declararlo: de ahí la afirmación de
      // tipo del cierre, que lo nombra en vez de quitarlo.
      renotify: false,
      // Nada de esta casa justifica quedarse en pantalla hasta que alguien la
      // toque, ni sonar por encima de lo que la persona esté haciendo.
      requireInteraction: false,
      silent: false,
      data: { url: notice.url ?? '/' }
    } as NotificationOptions & { renotify: boolean });
  })());
});

/**
 * Tocar el aviso lleva a donde se atiende el hecho.
 *
 * Si ya hay una ventana de la aplicación abierta se reutiliza en vez de abrir
 * otra: en un móvil, dos instancias de la misma aplicación es un estado del
 * que cuesta salir.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target).catch(() => client);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  /*
   * La API se sirve tal cual, sin pasar por ninguna caché ni por ningún
   * fallback. Un enlace a un PDF —el recibo archivado, con `target="_blank"`, o
   * el documento de pago, con `download`— es para el navegador una NAVEGACIÓN,
   * así que sin esta salida entraría por la rama de abajo y su 503 se cambiaría
   * por la página «Sin conexión». Y 503 es justo lo que estos endpoints
   * responden en sus fallos honestos (entre ellos el desajuste de almacén, cuyo
   * mensaje nombra a propósito los dos buckets): la persona vería «Sin
   * conexión» teniendo conexión y el motivo real se perdería por el camino.
   *
   * El fondo es que un PDF, un ZIP o un JSON no son «lo último que se guardó en
   * este dispositivo»: la copia de una pantalla no los sustituye, ni con 503 ni
   * sin red. La avería venía de main y esta salida arregla también su endpoint
   * del documento de pago.
   */
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

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
