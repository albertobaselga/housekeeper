/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

const STATIC_CACHE = `casa-clara-static-${version}`;
const PAGE_CACHE = `casa-clara-pages-${version}`;
const PRECACHE = [...build, ...files];

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
      try {
        const response = await fetch(request);
        if (response.ok) await pageCache.put(request, response.clone());
        return response;
      } catch {
        return (await pageCache.match(request))
          ?? (await pageCache.match('/offline'))
          ?? new Response('Sin conexión', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  const url = new URL(request.url);
  if (url.origin === self.location.origin && PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
  }
});
