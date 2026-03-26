/**
 * SentinelCareAI — Cloudflare Worker Proxy
 * ─────────────────────────────────────────
 * Intermediario seguro entre el frontend y la API de Groq.
 * La API key NUNCA llega al navegador.
 *
 * ENDPOINTS:
 *   POST /chat        → Groq chat completions (Llama / Aura)
 *   POST /transcribe  → Groq Whisper transcription (voz)
 *
 * RATE LIMITING (en memoria, por IP):
 *   - Máx. 30 requests por minuto por IP  (ventana deslizante)
 *   - Máx. 500 requests por día  por IP
 *   Se resetea automáticamente al expirar la ventana.
 *   Nota: al ser en memoria, se resetea si el worker se reinicia.
 *   Para persistencia total se necesitaría Cloudflare KV (plan pago).
 */

// ── Dominios autorizados ──────────────────────────────────
const ALLOWED_ORIGINS = [
  'http://localhost', 
  'http://127.0.0.1:5500', // puerto común para live server, pero se permite cualquier puerto en localhost
  'http://127.0.0.1', 
  'null',                              // file:// local
  'https://pablogalvan22.github.io',   // GitHub Pages
];

const GROQ_CHAT_URL       = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// ── Rate limit config ─────────────────────────────────────
const RL_WINDOW_MS   = 60 * 1000;   // ventana de 1 minuto
const RL_MAX_MINUTE  = 30;           // máx requests por minuto
const RL_MAX_DAY     = 500;          // máx requests por día
const RL_DAY_MS      = 24 * 3600 * 1000;

// ── Validación de input ───────────────────────────────────
// Limites para prevenir abuso de tokens y ataques de payload grande.
const MSG_MAX_COUNT   = 35;    // máx mensajes en el historial (frontend usa hasta 30)
const MSG_MAX_CHARS   = 8000;  // máx caracteres por mensaje
                               // (extracción de memoria: perfil ~2000 + conversación ~4000 + headers)

// ── Modelos y fallback ────────────────────────────────────
// Si el modelo primario falla (error 5xx o red), el worker reintenta
// automáticamente con el modelo de respaldo antes de devolver error.
const PRIMARY_MODEL  = 'llama-3.3-70b-versatile';
const FALLBACK_MODEL = 'llama-3.1-8b-instant';

// ── Rate limiting — híbrido KV / memoria ─────────────────
//
// Usa Cloudflare KV cuando el binding RATE_LIMIT_KV está configurado
// (persistente entre cold starts e instancias). Si no está disponible,
// cae automáticamente a almacenamiento en memoria (best-effort).
//
// CÓMO ACTIVAR KV (2 pasos):
//
//   1. Crear el namespace:
//        wrangler kv:namespace create "RATE_LIMIT"
//      Copia el `id` que devuelve y pégalo en wrangler.toml
//      (ya hay un bloque [[kv_namespaces]] preparado — solo pon el id).
//
//   2. Desplegar:
//        wrangler deploy
//
//   A partir de ahí el rate limit sobrevive reinicios y funciona
//   igual en todas las instancias del worker.

// Fallback en memoria para cuando KV no está configurado
const rateLimitStore = new Map();

function checkRateLimitMemory(ip) {
  const now   = Date.now();
  let entry   = rateLimitStore.get(ip);

  if (!entry) {
    entry = { minuteCount: 0, minuteStart: now, dayCount: 0, dayStart: now };
    rateLimitStore.set(ip, entry);
  }

  if (now - entry.minuteStart > RL_WINDOW_MS) { entry.minuteCount = 0; entry.minuteStart = now; }
  if (now - entry.dayStart    > RL_DAY_MS)    { entry.dayCount    = 0; entry.dayStart    = now; }

  entry.minuteCount++;
  entry.dayCount++;

  // Evitar que el Map crezca indefinidamente
  if (rateLimitStore.size > 5000) {
    for (const [key, val] of rateLimitStore) {
      if (now - val.minuteStart > RL_WINDOW_MS * 2) rateLimitStore.delete(key);
    }
  }

  if (entry.minuteCount > RL_MAX_MINUTE) {
    const retryAfter = Math.ceil((entry.minuteStart + RL_WINDOW_MS - now) / 1000);
    return { blocked: true, reason: `Demasiadas peticiones. Intenta de nuevo en ${retryAfter}s.`, retryAfter };
  }
  if (entry.dayCount > RL_MAX_DAY) {
    const retryAfter = Math.ceil((entry.dayStart + RL_DAY_MS - now) / 1000);
    return { blocked: true, reason: 'Límite diario alcanzado. Intenta mañana.', retryAfter };
  }
  return { blocked: false };
}

async function checkRateLimitKV(ip, kv) {
  const now    = Date.now();
  const minKey = `rl:min:${ip}`;
  const dayKey = `rl:day:${ip}`;

  const [minRaw, dayRaw] = await Promise.all([
    kv.get(minKey, { type: 'json' }),
    kv.get(dayKey, { type: 'json' }),
  ]);

  const minEntry = minRaw || { count: 0, start: now };
  const dayEntry = dayRaw || { count: 0, start: now };

  if (now - minEntry.start > RL_WINDOW_MS) { minEntry.count = 0; minEntry.start = now; }
  if (now - dayEntry.start > RL_DAY_MS)    { dayEntry.count = 0; dayEntry.start = now; }

  minEntry.count++;
  dayEntry.count++;

  await Promise.all([
    kv.put(minKey, JSON.stringify(minEntry), { expirationTtl: Math.ceil(RL_WINDOW_MS / 1000) }),
    kv.put(dayKey, JSON.stringify(dayEntry), { expirationTtl: Math.ceil(RL_DAY_MS    / 1000) }),
  ]);

  if (minEntry.count > RL_MAX_MINUTE) {
    const retryAfter = Math.ceil((minEntry.start + RL_WINDOW_MS - now) / 1000);
    return { blocked: true, reason: `Demasiadas peticiones. Intenta de nuevo en ${retryAfter}s.`, retryAfter };
  }
  if (dayEntry.count > RL_MAX_DAY) {
    const retryAfter = Math.ceil((dayEntry.start + RL_DAY_MS - now) / 1000);
    return { blocked: true, reason: 'Límite diario alcanzado. Intenta mañana.', retryAfter };
  }
  return { blocked: false };
}

// Punto de entrada unificado: usa KV si está disponible, memoria si no
async function checkRateLimit(ip, env) {
  if (env.RATE_LIMIT_KV) {
    try {
      return await checkRateLimitKV(ip, env.RATE_LIMIT_KV);
    } catch (err) {
      // Si KV falla por alguna razón, caemos a memoria sin romper el request
      console.warn('[RL] KV falló, usando memoria:', err.message);
    }
  }
  return checkRateLimitMemory(ip);
}

// ── Security headers (todas las respuestas) ───────────────
// CSP restrictivo: el worker solo emite JSON, nunca HTML ejecutable.
// Esto previene que un atacante use el worker como relay de XSS si el
// frontend se compromete y redirige respuestas a un contexto de documento.
const SECURITY_HEADERS = {
  'Content-Security-Policy':        "default-src 'none'",
  'X-Content-Type-Options':         'nosniff',
  'X-Frame-Options':                'DENY',
  'Referrer-Policy':                'no-referrer',
  'Permissions-Policy':             'interest-cohort=()',
};

// ── Helpers CORS ──────────────────────────────────────────
function corsHeaders(origin) {
  // Si el origen no está en la lista autorizada no se devuelve ningún header
  // Access-Control-Allow-Origin. El navegador bloqueará la respuesta por CORS.
  // Nota: no lanzamos un error aquí — el worker responde normalmente, pero sin
  // el header CORS el navegador descartará la respuesta en dominios no autorizados.
  if (!ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',   // necesario para cachés correctas
  };
}

function jsonResponse(body, status = 200, origin = '*', extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...SECURITY_HEADERS,
      ...corsHeaders(origin),
      ...extra,
    },
  });
}

function errorResponse(message, status, origin, extra = {}) {
  return jsonResponse({ error: { message } }, status, origin, extra);
}

// ── Error logging — webhook opcional ─────────────────────
// Si el secret ERROR_WEBHOOK_URL está configurado, los errores de Groq
// se envían a ese endpoint (Slack, Discord, Make, n8n, etc.).
// El envío es fire-and-forget: nunca bloquea ni afecta la respuesta al usuario.
//
// CÓMO ACTIVAR:
//   wrangler secret put ERROR_WEBHOOK_URL
//   → Pega la URL del webhook de Slack/Discord cuando te la pida.
//
// Formato Slack (incoming webhook):  https://hooks.slack.com/services/…
// Formato Discord:                   https://discord.com/api/webhooks/…
//
// El worker detecta automáticamente el formato por la URL y adapta el payload.
function logError(env, context) {
  if (!env.ERROR_WEBHOOK_URL) return; // no configurado → silencio total

  const url  = env.ERROR_WEBHOOK_URL;
  const text = `🚨 *SentinelCareAI Worker Error*\n` +
               `• Tipo: ${context.type}\n` +
               `• Modelo: ${context.model || '—'}\n` +
               `• Status: ${context.status || '—'}\n` +
               `• Detalle: ${context.detail || '—'}\n` +
               `• IP: ${context.ip || '—'}\n` +
               `• Hora: ${new Date().toISOString()}`;

  const isDiscord = url.includes('discord.com');
  const payload   = isDiscord ? { content: text } : { text };

  // Fire-and-forget: no await, no bloqueo
  fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  }).catch(err => console.warn('[logError] Webhook falló:', err.message));
}

// ── Main handler ──────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || 'null';
    const url    = new URL(request.url);

    // Preflight CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...SECURITY_HEADERS, ...corsHeaders(origin) },
      });
    }

    // Solo POST
    if (request.method !== 'POST') {
      return errorResponse('Método no permitido', 405, origin);
    }

    // Secrets configurados
    if (!env.GROQ_API_KEY) {
      console.error('GROQ_API_KEY secret not set');
      return errorResponse('Proxy mal configurado — falta GROQ_API_KEY', 500, origin);
    }
    if (!env.AURA_SYSTEM_PROMPT) {
      console.error('AURA_SYSTEM_PROMPT secret not set');
      return errorResponse('Proxy mal configurado — falta AURA_SYSTEM_PROMPT', 500, origin);
    }

    // ── Rate limiting ─────────────────────────────────────
    const ip = request.headers.get('CF-Connecting-IP')
            || request.headers.get('X-Forwarded-For')?.split(',')[0].trim()
            || 'unknown';

    const rl = await checkRateLimit(ip, env);
    if (rl.blocked) {
      console.warn(`Rate limit hit: ${ip} — ${rl.reason}`);
      return errorResponse(rl.reason, 429, origin, {
        'Retry-After': String(rl.retryAfter),
      });
    }

    const authHeader = { 'Authorization': 'Bearer ' + env.GROQ_API_KEY };

    // ── /chat ─────────────────────────────────────────────
    if (url.pathname === '/chat') {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('JSON inválido', 400, origin);
      }

      // Allowlist: solo se reenvían los campos permitidos con límites seguros.
      // Esto evita que un atacante use la key para llamar a modelos distintos
      // o inflar el costo con max_tokens o temperature abusivos.
      const ALLOWED_MODELS = [
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
        'llama-3.2-11b-vision-preview',
        'llama-3.2-90b-vision-preview',
        'mixtral-8x7b-32768',
        'gemma2-9b-it',
        'whisper-large-v3',
      ];
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return errorResponse('El campo "messages" es obligatorio y debe ser un array no vacío.', 400, origin);
      }

      // ── Validación de input ───────────────────────────────
      // 1. Demasiados mensajes: previene payloads que inflen el contexto
      //    (y por tanto el costo de tokens) más allá de lo razonable.
      const userMsgs = body.messages.filter(m => m.role !== 'system');
      if (userMsgs.length > MSG_MAX_COUNT) {
        return errorResponse(
          `Demasiados mensajes. Máximo permitido: ${MSG_MAX_COUNT}.`,
          400, origin
        );
      }

      // 2. Mensajes demasiado largos: previene un solo mensaje gigante que
      //    consuma miles de tokens y evada el límite de cantidad.
      for (const msg of userMsgs) {
        const content = typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content ?? '');
        if (content.length > MSG_MAX_CHARS) {
          return errorResponse(
            `Mensaje demasiado largo. Máximo ${MSG_MAX_CHARS} caracteres por mensaje.`,
            400, origin
          );
        }
      }
      const safe = {
        model:       ALLOWED_MODELS.includes(body.model) ? body.model : 'llama-3.3-70b-versatile',
        messages:    body.messages,
        temperature: Math.min(Math.max(body.temperature ?? 0.7, 0), 1.5),
        max_tokens:  Math.min(Math.max(body.max_tokens  ?? 1000, 1), 2000),
        ...(body.stream === true ? { stream: true } : {}),
      };

      // Inyectar system prompt server-side: filtra cualquier rol "system"
      // que venga del cliente (previene prompt injection) y prepende el nuestro.
      // El prompt se carga desde el secret AURA_SYSTEM_PROMPT — nunca está
      // en el código fuente ni en el repositorio.
      safe.messages = safe.messages.filter(function(m) { return m.role !== 'system'; });
      safe.messages = [
        { role: 'system', content: env.AURA_SYSTEM_PROMPT },
        ...safe.messages
      ];

      // ── Llamada a Groq con fallback de modelo ────────────
      // Intenta con el modelo seleccionado. Si Groq responde con un error
      // de servidor (5xx) o la red falla, reintenta automáticamente con
      // FALLBACK_MODEL antes de devolver error al usuario.
      const isStream = safe.stream === true;

      async function fetchGroq(model) {
        const payload = { ...safe, model };
        return fetch(GROQ_CHAT_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body:    JSON.stringify(payload),
        });
      }

      let groqRes;
      try {
        groqRes = await fetchGroq(safe.model);
        // Si el modelo primario devuelve error de servidor, probamos el fallback
        if (!groqRes.ok && groqRes.status >= 500 && safe.model !== FALLBACK_MODEL) {
          console.warn(`[Groq] ${safe.model} → ${groqRes.status}. Reintentando con ${FALLBACK_MODEL}.`);
          logError(env, { type: 'groq_5xx_fallback', model: safe.model, status: groqRes.status, ip });
          groqRes = await fetchGroq(FALLBACK_MODEL);
        }
      } catch (networkErr) {
        // Error de red en el modelo primario → intentar con fallback
        if (safe.model !== FALLBACK_MODEL) {
          console.warn(`[Groq] Red falló con ${safe.model}. Reintentando con ${FALLBACK_MODEL}.`);
          logError(env, { type: 'groq_network_fallback', model: safe.model, detail: networkErr.message, ip });
          try {
            groqRes = await fetchGroq(FALLBACK_MODEL);
          } catch (fallbackErr) {
            logError(env, { type: 'groq_fallback_failed', model: FALLBACK_MODEL, detail: fallbackErr.message, ip });
            return errorResponse('No se pudo conectar con el servicio de IA. Intenta de nuevo.', 503, origin);
          }
        } else {
          logError(env, { type: 'groq_network_error', model: safe.model, detail: networkErr.message, ip });
          return errorResponse('No se pudo conectar con el servicio de IA. Intenta de nuevo.', 503, origin);
        }
      }

      // ── Respuesta streaming ───────────────────────────────
      // Cuando stream=true, pasamos el cuerpo SSE directamente al cliente.
      // El frontend debe consumirlo con fetch + ReadableStream (ver docs).
      if (isStream) {
        return new Response(groqRes.body, {
          status: groqRes.status,
          headers: {
            'Content-Type':  'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',   // evita buffering en proxies
            ...SECURITY_HEADERS,
            ...corsHeaders(origin),
          },
        });
      }

      // ── Respuesta normal (JSON) ───────────────────────────
      const data = await groqRes.json();
      return jsonResponse(data, groqRes.status, origin);
    }

    // ── /transcribe ───────────────────────────────────────
    if (url.pathname === '/transcribe') {
      let formData;
      try {
        formData = await request.formData();
      } catch {
        return errorResponse('FormData inválido', 400, origin);
      }

      const groqRes = await fetch(GROQ_TRANSCRIBE_URL, {
        method:  'POST',
        headers: authHeader,
        body:    formData,
      });

      const data = await groqRes.json();
      return jsonResponse(data, groqRes.status, origin);
    }

    // ── /extract-memory ───────────────────────────────────
    // Endpoint exclusivo para la extracción de perfil emocional.
    // A diferencia de /chat, NO inyecta AURA_SYSTEM_PROMPT:
    // el system prompt de análisis viene del cliente y se respeta tal cual.
    // Esto evita que el modelo responda como terapeuta en lugar de
    // devolver el JSON de perfil que buildMemoryContext() espera.
    if (url.pathname === '/extract-memory') {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('JSON inválido', 400, origin);
      }

      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return errorResponse('El campo "messages" es obligatorio y debe ser un array no vacío.', 400, origin);
      }

      // Validación idéntica a /chat para consistencia y seguridad
      const userMsgs = body.messages.filter(m => m.role !== 'system');
      if (userMsgs.length > MSG_MAX_COUNT) {
        return errorResponse(`Demasiados mensajes. Máximo permitido: ${MSG_MAX_COUNT}.`, 400, origin);
      }
      for (const msg of body.messages) {
        const content = typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content ?? '');
        if (content.length > MSG_MAX_CHARS) {
          return errorResponse(`Mensaje demasiado largo. Máximo ${MSG_MAX_CHARS} caracteres por mensaje.`, 400, origin);
        }
      }

      const ALLOWED_MODELS = [
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
      ];

      const safe = {
        model:       ALLOWED_MODELS.includes(body.model) ? body.model : 'llama-3.3-70b-versatile',
        messages:    body.messages, // se pasan tal cual — sin inyectar AURA_SYSTEM_PROMPT
        temperature: Math.min(Math.max(body.temperature ?? 0.1, 0), 0.5), // rango más estricto: extracción debe ser determinista
        max_tokens:  Math.min(Math.max(body.max_tokens  ?? 1200, 1), 1500),
      };

      let groqRes;
      try {
        groqRes = await fetch(GROQ_CHAT_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body:    JSON.stringify(safe),
        });
        if (!groqRes.ok && groqRes.status >= 500) {
          // Fallback al modelo ligero
          const fallback = { ...safe, model: 'llama-3.1-8b-instant' };
          groqRes = await fetch(GROQ_CHAT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeader },
            body: JSON.stringify(fallback),
          });
        }
      } catch (err) {
        logError(env, { type: 'extract_memory_error', detail: err.message, ip });
        return errorResponse('No se pudo conectar con el servicio de IA.', 503, origin);
      }

      const data = await groqRes.json();
      return jsonResponse(data, groqRes.status, origin);
    }

    return errorResponse('Ruta no encontrada. Usa /chat, /transcribe o /extract-memory', 404, origin);
  },
};