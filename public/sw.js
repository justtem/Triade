const CACHE_NAME = "ai-council-pwa-v1";
const PRECACHE_URLS = [
  "/offline.html",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Nunca intercepta SSE nem endpoints de API (sempre 100% em tempo real)
  if (
    url.pathname.startsWith("/events") ||
    url.pathname.startsWith("/status") ||
    url.pathname.startsWith("/debates") ||
    url.pathname.startsWith("/providers") ||
    url.pathname.startsWith("/templates") ||
    url.pathname.startsWith("/projects") ||
    url.pathname.startsWith("/user-memory") ||
    url.pathname.startsWith("/privacy") ||
    url.pathname.startsWith("/setup") ||
    url.pathname.startsWith("/audio") ||
    url.pathname.startsWith("/auth")
  ) {
    return;
  }

  // Navegação principal: network-first com fallback elegante para offline.html
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Tailscale Serve retorna 502/503/504 quando o servidor do PC está desligado
          if (response.status >= 502 && response.status <= 504) {
            return caches.match("/offline.html").then((cached) => cached || response);
          }
          return response;
        })
        .catch(() =>
          caches
            .match("/offline.html")
            .then((cached) => cached || new Response("AI Council offline.", { status: 503 }))
        )
    );
    return;
  }

  // Ícones estáticos: cache-first leve com atualização em background
  if (url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE_NAME).then((c) => c.put(request, copy)).catch(() => {});
            }
            return res;
          })
      )
    );
  }
});
