/**
 * SentinelCareAI — Service Worker v2
 * ────────────────────────────────────────────────────────────────
 * Estrategia:
 *   • Proxy Groq          → siempre network, nunca cachear
 *   • CDN externos        → cache-first (fonts, Chart.js, marked…)
 *   • Assets propios      → network-first con fallback a cache
 *   • Navegación sin red  → devuelve offline.html (Fix #8)
 *
 * offline.html se precachea en install para estar siempre disponible.
 */

const CACHE_NAME  = 'sentinelcare-v2';   // bump version → limpia cache anterior
const PROXY_HOST  = 'sentinel-proxy.sentinelpablo.workers.dev';
const OFFLINE_URL = './offline.html';

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  OFFLINE_URL,           // ← nuevo: fallback garantizado offline
];

// ── Instalación ───────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS).catch(err => {
        // Si offline.html falla (ej: despliegue parcial), continuamos igualmente
        console.warn('[SW] Precache parcial:', err);
      }))
      .then(() => self.skipWaiting())
  );
});

// ── Activación — limpiar caches viejos ───────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => {
            console.log('[SW] Eliminando cache obsoleto:', k);
            return caches.delete(k);
          })
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // ① Proxy de Groq → siempre network, nunca cachear
  if (url.hostname.includes(PROXY_HOST)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // ② Solo GET (POST/PUT/DELETE nunca se cachean)
  if (event.request.method !== 'GET') return;

  // ③ CDN externos → cache-first con actualización en background
  if (url.origin !== location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        const networkFetch = fetch(event.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        });
        // Devuelve caché inmediatamente si existe; red en background
        return cached || networkFetch.catch(() => cached);
      })
    );
    return;
  }

  // ④ Navegación (HTML pages) → network-first con fallback a offline.html
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(event.request)
            .then(cached => cached || caches.match(OFFLINE_URL))
        )
    );
    return;
  }

  // ⑤ Assets propios (JS/CSS/imágenes) → network-first con fallback a cache
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
