self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.registration.unregister(),
      caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("evora-gestao-")).map((key) => caches.delete(key)))),
    ]).then(() => self.clients.matchAll({ type: "window", includeUncontrolled: true })).then((clients) => {
      for (const client of clients) client.navigate(client.url);
    }).catch(() => undefined),
  );
});
