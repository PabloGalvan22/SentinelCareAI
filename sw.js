/**
 * SentinelCareAI — Service Worker
 * ────────────────────────────────
 * Estrategia: Cache-first para assets estáticos,
 * Network-first para llamadas al proxy (chat/transcribe).
 */

const CACHE_NAME    = 'sentinelcare-v1';
const PROXY_ORIGIN  = 'sentinel-proxy.sentinelpablo.workers.dev';

// Assets a pre-cachear al instalar
const PRECACHE_URLS = [
  '/SentinelCareAI/',
  '/SentinelCareAI/index.html',
  '/SentinelCareAI/manifest.json',
  // CDN fonts y librerías se cachean dinámicamente al primer uso
];

// ── Instalación: pre-cachear assets principales ──────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── Activación: limpiar caches viejos ────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: estrategia según tipo de request ──────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Llamadas al proxy → siempre Network (nunca cachear datos del chat)
  if (url.hostname.includes(PROXY_ORIGIN)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 2. CDN externas (fonts, librerías) → Cache-first con fallback a network
  if (url.origin !== location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => cached); // si falla la red, usa caché aunque esté "stale"
      })
    );
    return;
  }

  // 3. Assets propios (HTML, manifest) → Network-first con fallback a cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
