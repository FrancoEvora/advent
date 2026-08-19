const CACHE = "evora-gestao-v6-25-2-static";
const STATIC_ASSETS = [
  "/manifest.webmanifest",
  "/icon.svg",
  "/evora-brand.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navegações ficam a cargo do navegador. Interceptá-las com respondWith(fetch())
  // faz o Safari exibir "FetchEvent.respondWith ... TypeError: Load failed" quando
  // há qualquer falha transitória de rede durante uma navegação.
  if (request.mode === "navigate") return;

  const cacheableDestinations = new Set(["style", "script", "image", "font", "manifest"]);
  if (!cacheableDestinations.has(request.destination)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        event.waitUntil(
          fetch(request)
            .then((response) => {
              if (response.ok && response.type === "basic") {
                return caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
              }
            })
            .catch(() => undefined),
        );
        return cached;
      }

      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
        }
        return response;
      });
    }),
  );
});
