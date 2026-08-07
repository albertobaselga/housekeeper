const CACHE_PREFIX = "casa-clara-";
const CACHE_VERSION = `${CACHE_PREFIX}shell-v5`;
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./auth.js",
  "./data.js",
  "./logic.js",
  "./offline.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
];
const INDEX_URL = new URL("./index.html", self.location.href).href;
const ROOT_URL = new URL("./", self.location.href).href;
const ROOT_PATH = new URL(ROOT_URL).pathname;
const INDEX_PATH = new URL(INDEX_URL).pathname;
const SHELL_URLS = new Set(APP_SHELL.map((path) => new URL(path, self.location.href).href));

function isHtmlResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  return response.ok && response.status >= 200 && response.status < 300 && contentType.includes("text/html");
}

function isStaticResponse(response) {
  return response.ok && response.status >= 200 && response.status < 300 && response.type !== "opaque";
}

function offlineFallback() {
  return new Response(
    "<!doctype html><html lang=\"es\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Casa Clara sin conexión</title><body><main><h1>Casa Clara no está disponible sin conexión</h1><p>Abre la aplicación con conexión una vez y vuelve a intentarlo.</p></main></body></html>",
    {
      status: 503,
      statusText: "Offline",
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    },
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

async function navigate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const requestUrl = new URL(request.url);
  const isAppEntry = requestUrl.origin === self.location.origin && (requestUrl.pathname === ROOT_PATH || requestUrl.pathname === INDEX_PATH);

  try {
    const response = await fetch(request);
    if (isAppEntry && isHtmlResponse(response)) {
      await cache.put(INDEX_URL, response.clone());
    }
    return response;
  } catch {
    if (!isAppEntry) return offlineFallback();
    return (await cache.match(INDEX_URL))
      || (await cache.match(ROOT_URL))
      || (await caches.match(INDEX_URL))
      || offlineFallback();
  }
}

function serveShellAsset(event) {
  const request = event.request;
  const cachePromise = caches.open(CACHE_VERSION);
  const refresh = fetch(request).then(async (response) => {
    if (isStaticResponse(response)) {
      const cache = await cachePromise;
      await cache.put(request, response.clone());
    }
    return response;
  });

  event.waitUntil(refresh.catch(() => undefined));
  event.respondWith(
    cachePromise.then((cache) => cache.match(request)).then((cached) => cached || refresh.catch(() => Response.error())),
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(navigate(request));
    return;
  }

  if (!SHELL_URLS.has(url.href)) return;
  serveShellAsset(event);
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
