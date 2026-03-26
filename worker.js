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

// ── Token usage logging — fire-and-forget ────────────────
// Registra el uso de tokens por request en KV.
// Clave: tokens:YYYY-MM-DD:RANDOM  TTL: 90 días
// Campos: endpoint, model, prompt_tokens, completion_tokens, total_tokens, ts
function logTokens(env, { endpoint, model, usage }) {
  if (!env.RATE_LIMIT_KV || !usage) return;
  const now  = Date.now();
  const day  = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
  const id   = `tokens:${day}:${Math.random().toString(36).slice(2, 9)}`;
  const entry = {
    ts:                now,
    endpoint,
    model,
    prompt_tokens:     usage.prompt_tokens     || 0,
    completion_tokens: usage.completion_tokens || 0,
    total_tokens:      usage.total_tokens      || 0,
  };
  env.RATE_LIMIT_KV.put(id, JSON.stringify(entry), { expirationTtl: 60 * 60 * 24 * 90 })
    .catch(e => console.warn('[logTokens] KV write failed:', e.message));
}
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

      // ── Llamada a Groq con backoff exponencial + fallback de modelo ──
      //
      // ESTRATEGIA:
      //   1. Intenta con el modelo primario hasta MAX_RETRIES veces.
      //      - 429 (rate limit Groq) → espera Retry-After o backoff, reintenta.
      //      - 503 / 5xx            → backoff, reintenta.
      //      - Error de red         → backoff, reintenta.
      //   2. Si se agotan los reintentos o sigue fallando → fallback a FALLBACK_MODEL
      //      con la misma lógica de backoff.
      //   3. Si el fallback también falla → error al usuario.
      //
      // NOTA STREAMING: no se puede reintentar un stream a medias.
      // Para stream=true se hace un solo intento; si falla se cae directo
      // al fallback (sin backoff) para no dejar al usuario esperando.

      const isStream   = safe.stream === true;
      const MAX_RETRIES = 3;                      // intentos por modelo
      const BASE_DELAY  = 1000;                   // ms — se duplica cada intento

      // Espera ms milisegundos (respetando el límite de 10 s para no agotar el worker)
      const sleep = ms => new Promise(r => setTimeout(r, Math.min(ms, 10000)));

      // Un solo fetch a Groq con el modelo indicado
      async function fetchGroq(model) {
        const payload = { ...safe, model };
        return fetch(GROQ_CHAT_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body:    JSON.stringify(payload),
        });
      }

      // Fetch con backoff: reintenta en 429 / 5xx / red hasta maxRetries veces.
      // Devuelve { res } si tuvo éxito, o lanza el último error si agotó intentos.
      async function fetchGroqWithBackoff(model, maxRetries) {
        let lastErr;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            const res = await fetchGroq(model);

            // Éxito o error de cliente (4xx salvo 429) → devolver sin reintentar
            if (res.ok || (res.status < 500 && res.status !== 429)) return res;

            // 429: respetar Retry-After si Groq lo manda, si no usar backoff
            if (res.status === 429) {
              const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
              const wait = retryAfter > 0 ? retryAfter * 1000 : BASE_DELAY * Math.pow(2, attempt);
              console.warn(`[Groq] 429 en ${model} (intento ${attempt + 1}). Esperando ${wait}ms.`);
              logError(env, { type: 'groq_429', model, attempt, wait, ip });
              if (attempt < maxRetries - 1) await sleep(wait);
              lastErr = res;
              continue;
            }

            // 5xx: backoff exponencial
            const wait = BASE_DELAY * Math.pow(2, attempt);
            console.warn(`[Groq] ${res.status} en ${model} (intento ${attempt + 1}). Esperando ${wait}ms.`);
            logError(env, { type: 'groq_5xx', model, status: res.status, attempt, ip });
            if (attempt < maxRetries - 1) await sleep(wait);
            lastErr = res;

          } catch (networkErr) {
            // Error de red: backoff exponencial
            const wait = BASE_DELAY * Math.pow(2, attempt);
            console.warn(`[Groq] Red falló con ${model} (intento ${attempt + 1}): ${networkErr.message}. Esperando ${wait}ms.`);
            logError(env, { type: 'groq_network', model, attempt, detail: networkErr.message, ip });
            if (attempt < maxRetries - 1) await sleep(wait);
            lastErr = networkErr;
          }
        }
        throw lastErr; // agotados los intentos
      }

      let groqRes;

      if (isStream) {
        // Stream: un intento directo; si falla, cae al fallback sin backoff
        try {
          groqRes = await fetchGroq(safe.model);
          if (!groqRes.ok && safe.model !== FALLBACK_MODEL) {
            console.warn(`[Groq] Stream falló con ${safe.model} (${groqRes.status}). Usando ${FALLBACK_MODEL}.`);
            logError(env, { type: 'groq_stream_fallback', model: safe.model, status: groqRes.status, ip });
            groqRes = await fetchGroq(FALLBACK_MODEL);
          }
        } catch (err) {
          if (safe.model !== FALLBACK_MODEL) {
            try { groqRes = await fetchGroq(FALLBACK_MODEL); }
            catch (fb) { return errorResponse('No se pudo conectar con el servicio de IA. Intenta de nuevo.', 503, origin); }
          } else {
            return errorResponse('No se pudo conectar con el servicio de IA. Intenta de nuevo.', 503, origin);
          }
        }
      } else {
        // No-stream: backoff completo en modelo primario, luego fallback con backoff
        try {
          groqRes = await fetchGroqWithBackoff(safe.model, MAX_RETRIES);
          // Si después del backoff el primario sigue mal → fallback
          if (!groqRes.ok && safe.model !== FALLBACK_MODEL) {
            console.warn(`[Groq] Primario agotado. Usando fallback ${FALLBACK_MODEL}.`);
            logError(env, { type: 'groq_fallback_after_backoff', model: safe.model, status: groqRes.status, ip });
            try {
              groqRes = await fetchGroqWithBackoff(FALLBACK_MODEL, MAX_RETRIES);
            } catch (fbErr) {
              logError(env, { type: 'groq_fallback_exhausted', model: FALLBACK_MODEL, ip });
              return errorResponse('El servicio de IA no está disponible en este momento. Intenta de nuevo en unos minutos.', 503, origin);
            }
          }
        } catch (primaryErr) {
          if (safe.model !== FALLBACK_MODEL) {
            console.warn(`[Groq] Primario lanzó error. Usando fallback ${FALLBACK_MODEL}.`);
            try {
              groqRes = await fetchGroqWithBackoff(FALLBACK_MODEL, MAX_RETRIES);
            } catch (fbErr) {
              logError(env, { type: 'groq_fallback_exhausted', model: FALLBACK_MODEL, ip });
              return errorResponse('El servicio de IA no está disponible en este momento. Intenta de nuevo en unos minutos.', 503, origin);
            }
          } else {
            logError(env, { type: 'groq_exhausted', model: safe.model, ip });
            return errorResponse('El servicio de IA no está disponible en este momento. Intenta de nuevo en unos minutos.', 503, origin);
          }
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
      // Log de tokens (fire-and-forget)
      if (groqRes.ok && data.usage) {
        logTokens(env, { endpoint: 'chat', model: safe.model, usage: data.usage });
      }
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

    // ── /extract-memory ───────────────────────────────
    // Extracción de perfil emocional. NO inyecta AURA_SYSTEM_PROMPT —
    // el system prompt de análisis viene del cliente y se respeta tal cual.
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

      const ALLOWED_MODELS_MEM = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
      const safe = {
        model:       ALLOWED_MODELS_MEM.includes(body.model) ? body.model : 'llama-3.3-70b-versatile',
        messages:    body.messages,
        temperature: Math.min(Math.max(body.temperature ?? 0.1, 0), 0.5),
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
      // Log de tokens (fire-and-forget)
      if (groqRes.ok && data.usage) {
        logTokens(env, { endpoint: 'extract-memory', model: safe.model, usage: data.usage });
      }
      return jsonResponse(data, groqRes.status, origin);
    }

    // ── /verify-pro ───────────────────────────────────
    // Valida la contraseña del modo profesional server-side.
    // El hash NUNCA viaja al cliente — vive como secret cifrado en Cloudflare.
    //
    // CONFIGURAR (una sola vez):
    //   node -e "const c=require('crypto');process.stdout.write(c.createHash('sha256').update('TU_CONTRASEÑA').digest('base64'))"
    //   wrangler secret put PRO_PASSWORD_HASH   ← pega el output anterior
    //
    // Rate limit propio: máx 5 intentos por minuto por IP (anti-fuerza bruta).
    if (url.pathname === '/verify-pro') {
      if (!env.PRO_PASSWORD_HASH) {
        console.error('PRO_PASSWORD_HASH secret not set');
        return errorResponse('Proxy mal configurado — falta PRO_PASSWORD_HASH', 500, origin);
      }

      // Rate limit más estricto para este endpoint: 5 intentos por minuto por IP
      const proKey = `rl:pro:${ip}`;
      let proBlocked = false;
      if (env.RATE_LIMIT_KV) {
        try {
          const now   = Date.now();
          const raw   = await env.RATE_LIMIT_KV.get(proKey, { type: 'json' });
          const entry = raw || { count: 0, start: now };
          if (now - entry.start > RL_WINDOW_MS) { entry.count = 0; entry.start = now; }
          entry.count++;
          await env.RATE_LIMIT_KV.put(proKey, JSON.stringify(entry), { expirationTtl: Math.ceil(RL_WINDOW_MS / 1000) });
          if (entry.count > 5) proBlocked = true;
        } catch (e) { /* KV falló — permitimos el intento */ }
      }
      if (proBlocked) {
        return errorResponse('Demasiados intentos. Espera un minuto e inténtalo de nuevo.', 429, origin);
      }

      let body;
      try { body = await request.json(); } catch {
        return errorResponse('JSON inválido', 400, origin);
      }

      const pwd = typeof body.password === 'string' ? body.password : '';
      if (!pwd) return errorResponse('Contraseña requerida.', 400, origin);

      // Hashear la contraseña recibida con SHA-256
      const encoder = new TextEncoder();
      const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(pwd));
      const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hashBuf)));

      // Comparación en tiempo constante para prevenir timing attacks.
      // Simulamos timingSafeEqual con XOR byte a byte.
      const a    = encoder.encode(hashB64);
      const b    = encoder.encode(env.PRO_PASSWORD_HASH);
      let   diff = a.length ^ b.length; // 0 si las longitudes coinciden
      const len  = Math.min(a.length, b.length);
      for (let i = 0; i < len; i++) diff |= a[i] ^ b[i];
      const ok = diff === 0;

      // Siempre mismo status 200 — no filtramos info por status code
      return jsonResponse({ ok }, 200, origin);
    }

    // ── /log-crisis ───────────────────────────────────
    // Registra un evento de crisis de forma anónima en KV.
    // DATOS: timestamp, perfil, activado_por, fragmento del último mensaje (máx 120 chars).
    // NO se guarda: nombre, IP ni ningún dato identificable.
    // TTL: 90 días. Si KV no está disponible el log se descarta silenciosamente.
    if (url.pathname === '/log-crisis') {
      let body;
      try { body = await request.json(); } catch {
        return errorResponse('JSON inválido', 400, origin);
      }
      if (env.RATE_LIMIT_KV) {
        try {
          const now   = Date.now();
          const id    = `crisis:${now}:${Math.random().toString(36).slice(2, 8)}`;
          const entry = {
            timestamp:    new Date(now).toISOString(),
            perfil:       ['joven','adulto','padre'].includes(body.perfil) ? body.perfil : 'desconocido',
            activado_por: body.activado_por === 'usuario' ? 'usuario' : 'aura',
            fragmento:    typeof body.fragmento === 'string'
                            ? body.fragmento.slice(0, 120).replace(/\s+/g, ' ').trim()
                            : '',
          };
          await env.RATE_LIMIT_KV.put(id, JSON.stringify(entry), { expirationTtl: 60 * 60 * 24 * 90 });
        } catch (e) {
          console.warn('[log-crisis] KV write failed:', e.message);
        }
      }
      return jsonResponse({ ok: true }, 200, origin);
    }

    // ── /crisis-logs ──────────────────────────────────
    // Devuelve los eventos de crisis registrados.
    // Protegido con la misma contraseña del modo profesional (PRO_PASSWORD_HASH).
    if (url.pathname === '/crisis-logs') {
      if (!env.PRO_PASSWORD_HASH) {
        return errorResponse('Proxy mal configurado — falta PRO_PASSWORD_HASH', 500, origin);
      }
      let body;
      try { body = await request.json(); } catch {
        return errorResponse('JSON inválido', 400, origin);
      }
      // Verificar contraseña — misma lógica en tiempo constante que /verify-pro
      const enc2    = new TextEncoder();
      const hBuf    = await crypto.subtle.digest('SHA-256', enc2.encode(body.password || ''));
      const hB64    = btoa(String.fromCharCode(...new Uint8Array(hBuf)));
      const ca      = enc2.encode(hB64);
      const cb      = enc2.encode(env.PRO_PASSWORD_HASH);
      let   cdiff   = ca.length ^ cb.length;
      const clen    = Math.min(ca.length, cb.length);
      for (let i = 0; i < clen; i++) cdiff |= ca[i] ^ cb[i];
      if (cdiff !== 0) return errorResponse('No autorizado.', 401, origin);

      if (!env.RATE_LIMIT_KV) {
        return jsonResponse({ logs: [], warning: 'KV no configurado — no hay logs disponibles.' }, 200, origin);
      }
      try {
        const list = await env.RATE_LIMIT_KV.list({ prefix: 'crisis:' });
        const logs = await Promise.all(
          list.keys.map(async k => {
            const raw = await env.RATE_LIMIT_KV.get(k.name);
            try { return JSON.parse(raw); } catch { return null; }
          })
        );
        const sorted = logs
          .filter(Boolean)
          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        return jsonResponse({ logs: sorted }, 200, origin);
      } catch (e) {
        return errorResponse('Error al leer logs.', 500, origin);
      }
    }

    // ── /token-stats ──────────────────────────────────
    // Devuelve el uso de tokens agregado por día y por modelo.
    // Protegido con PRO_PASSWORD_HASH.
    if (url.pathname === '/token-stats') {
      if (!env.PRO_PASSWORD_HASH) {
        return errorResponse('Proxy mal configurado — falta PRO_PASSWORD_HASH', 500, origin);
      }
      let body;
      try { body = await request.json(); } catch {
        return errorResponse('JSON inválido', 400, origin);
      }
      // Verificar contraseña en tiempo constante
      const enc3  = new TextEncoder();
      const hBuf3 = await crypto.subtle.digest('SHA-256', enc3.encode(body.password || ''));
      const hB643 = btoa(String.fromCharCode(...new Uint8Array(hBuf3)));
      const ta    = enc3.encode(hB643);
      const tb    = enc3.encode(env.PRO_PASSWORD_HASH);
      let   td    = ta.length ^ tb.length;
      const tl    = Math.min(ta.length, tb.length);
      for (let i = 0; i < tl; i++) td |= ta[i] ^ tb[i];
      if (td !== 0) return errorResponse('No autorizado.', 401, origin);

      if (!env.RATE_LIMIT_KV) {
        return jsonResponse({ stats: [], warning: 'KV no configurado.' }, 200, origin);
      }

      try {
        const list = await env.RATE_LIMIT_KV.list({ prefix: 'tokens:' });
        // Agregar por día y por modelo
        const byDay   = {};  // { 'YYYY-MM-DD': { prompt, completion, total, requests } }
        const byModel = {};  // { 'model-name': { prompt, completion, total, requests } }
        let grandTotal = { prompt: 0, completion: 0, total: 0, requests: 0 };

        await Promise.all(list.keys.map(async k => {
          try {
            const raw   = await env.RATE_LIMIT_KV.get(k.name);
            const entry = JSON.parse(raw);
            if (!entry || !entry.total_tokens) return;

            const day   = k.name.split(':')[1] || 'unknown';
            const model = entry.model || 'unknown';

            if (!byDay[day])     byDay[day]     = { prompt: 0, completion: 0, total: 0, requests: 0 };
            if (!byModel[model]) byModel[model] = { prompt: 0, completion: 0, total: 0, requests: 0 };

            byDay[day].prompt     += entry.prompt_tokens;
            byDay[day].completion += entry.completion_tokens;
            byDay[day].total      += entry.total_tokens;
            byDay[day].requests   += 1;

            byModel[model].prompt     += entry.prompt_tokens;
            byModel[model].completion += entry.completion_tokens;
            byModel[model].total      += entry.total_tokens;
            byModel[model].requests   += 1;

            grandTotal.prompt     += entry.prompt_tokens;
            grandTotal.completion += entry.completion_tokens;
            grandTotal.total      += entry.total_tokens;
            grandTotal.requests   += 1;
          } catch(e) {}
        }));

        // Ordenar días descendente
        const days = Object.entries(byDay)
          .sort((a, b) => b[0].localeCompare(a[0]))
          .map(([day, v]) => ({ day, ...v }));

        const models = Object.entries(byModel)
          .sort((a, b) => b[1].total - a[1].total)
          .map(([model, v]) => ({ model, ...v }));

        return jsonResponse({ days, models, grandTotal }, 200, origin);
      } catch(e) {
        return errorResponse('Error al leer estadísticas.', 500, origin);
      }
    }

    return errorResponse('Ruta no encontrada.', 404, origin);
  },
};