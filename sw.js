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

const CACHE_NAME  = 'sentinelcare-v3';   // bump version → limpia cache anterior
const PROXY_HOST  = 'sentinel-proxy.sentinelpablo.workers.dev';
const OFFLINE_URL = './offline.html';

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  OFFLINE_URL,           // ← nuevo: fallback garantizado offline
];

// Flag que indica si offline.html se precacheó correctamente en install.
// Si falló (despliegue parcial, primera carga sin red), el fallback de
// navegación devuelve una respuesta de error limpia en lugar de undefined.
let offlineCacheReady = false;

// ── Instalación ───────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS)
        .then(() => { offlineCacheReady = true; })
        .catch(err => {
          // Si offline.html falla, seguimos pero marcamos el flag
          console.warn('[SW] Precache parcial — offline.html puede no estar disponible:', err);
          offlineCacheReady = false;
        })
      )
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

// ── Clic en notificación de bienestar ─────────────────────
// Abre la app (o la enfoca si ya está abierta) al tocar la notificación.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Si la app ya está abierta en alguna pestaña, enfocarla
      for (const client of clients) {
        if (client.url.includes('/SentinelCareAI') && 'focus' in client) {
          return client.focus();
        }
      }
      // Si no, abrir una nueva ventana
      return self.clients.openWindow('./');
    })
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
          caches.match(event.request).then(cached => {
            if (cached) return cached;
            return caches.match(OFFLINE_URL).then(offlinePage => {
              if (offlinePage) return offlinePage;
              // offline.html no está en caché — devolver respuesta mínima
              // en lugar de undefined (que causaría un error genérico del navegador)
              console.warn('[SW] offline.html no está en caché. Devolviendo respuesta de error.');
              return new Response(
                '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">' +
                '<meta name="viewport" content="width=device-width,initial-scale=1">' +
                '<title>Sin conexión</title></head><body style="font-family:sans-serif;' +
                'display:flex;align-items:center;justify-content:center;min-height:100vh;' +
                'margin:0;background:#f0f4f0;"><div style="text-align:center;padding:32px">' +
                '<p style="font-size:1.1rem;color:#2c3e50">Sin conexión a internet.</p>' +
                '<p style="margin-top:12px;color:#555">Si necesitas ayuda urgente, llama al ' +
                '<a href="tel:8009112000" style="color:#c0392b;font-weight:700">800 911-2000</a>' +
                ' (CONASAMA) o al <a href="tel:911" style="color:#c0392b;font-weight:700">911</a>.' +
                '</p><button onclick="location.reload()" style="margin-top:20px;padding:10px 24px;' +
                'background:#3d7a8a;color:white;border:none;border-radius:10px;cursor:pointer;' +
                'font-size:0.95rem">Reintentar</button></div></body></html>',
                { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
              );
            });
          })
        )
    );
    return;
  }

  // ⑤ Assets propios (JS/CSS/imágenes) → stale-while-revalidate
  // Devuelve la versión en caché inmediatamente (carga rápida) y en paralelo
  // actualiza la caché con la versión más reciente de la red.
  // Si no hay caché todavía, espera la red normalmente.
  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(event.request).then(cached => {
        const networkFetch = fetch(event.request).then(res => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        }).catch(() => cached); // sin red y sin caché → undefined, manejado abajo

        // Si hay caché, la devolvemos de inmediato y actualizamos en background
        return cached || networkFetch;
      })
    )
  );
});