/**
 * SentinelCareAI — Service Worker
 * Estrategia: Cache-first para assets CDN,
 * Network-first para el HTML principal.
 */

const CACHE_NAME   = 'sentinelcare-v1';
const PROXY_HOST   = 'sentinel-proxy.sentinelpablo.workers.dev';

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
];

// Instalación
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// Activación — limpiar caches viejos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Proxy de Groq → siempre network, nunca cachear
  if (url.hostname.includes(PROXY_HOST)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // CDN externos → cache-first
  if (url.origin !== location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        }).catch(() => cached);
      })
    );
    return;
  }

  // Assets propios → network-first con fallback a cache
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});