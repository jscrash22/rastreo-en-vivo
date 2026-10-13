const VERSION = "rastreo-v2.0.0";
const STATIC_CACHE = `${VERSION}-static`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const APP_SHELL = [
  "./index.html",
  "./unete.html",
  "./manifest.webmanifest",
  "./css/styles.css",
  "./js/monitor.js",
  "./js/guest.js",
  "./js/config.js",
  "./js/utils.js",
  "./js/realtime.js",
  "./js/secure.js",
  "./js/route.js",
  "./js/history.js",
  "./js/geo.js",
  "./js/map.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await cache.addAll(APP_SHELL);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const claves = await caches.keys();
      await Promise.all(
        claves.filter((c) => !c.startsWith(VERSION)).map((c) => caches.delete(c))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

async function redPrimero(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const respuesta = await fetch(request);
    if (respuesta.ok) cache.put(request, respuesta.clone());
    return respuesta;
  } catch (err) {
    const cacheada = await cache.match(request, { ignoreSearch: true });
    if (cacheada) return cacheada;
    throw err;
  }
}

async function cachePrimero(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cacheada = await cache.match(request, { ignoreSearch: true });
  if (cacheada) {
    fetch(request)
      .then((r) => r.ok && cache.put(request, r.clone()))
      .catch(() => {});
    return cacheada;
  }
  const respuesta = await fetch(request);
  if (respuesta.ok) cache.put(request, respuesta.clone());
  return respuesta;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const mismoOrigen = url.origin === self.location.origin;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await redPrimero(request, STATIC_CACHE);
        } catch {
          const cache = await caches.open(STATIC_CACHE);
          return (await cache.match("./index.html")) || Response.error();
        }
      })()
    );
    return;
  }

  if (mismoOrigen) {
    const fresco = /\.(?:js|css|json|html|webmanifest)$/i.test(url.pathname) || url.pathname.endsWith("/");
    event.respondWith(fresco ? redPrimero(request, STATIC_CACHE) : cachePrimero(request, STATIC_CACHE));
    return;
  }

  if (url.hostname.includes("tile.openstreetmap.org") || url.hostname.includes("unpkg.com")) {
    event.respondWith(cachePrimero(request, RUNTIME_CACHE).catch(() => Response.error()));
  }
});
