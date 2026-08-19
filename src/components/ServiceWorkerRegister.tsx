"use client";

import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => undefined);

    if ("caches" in window) {
      void caches
        .keys()
        .then((keys) => Promise.all(keys.filter((key) => key.startsWith("evora-gestao-")).map((key) => caches.delete(key))))
        .catch(() => undefined);
    }
  }, []);

  return null;
}
