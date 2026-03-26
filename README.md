# SentinelCareAI — Contigo Siempre

Plataforma de apoyo emocional y detección de riesgo con inteligencia artificial, diseñada para el contexto mexicano. Combina una IA conversacional empática (Aura) con herramientas clínicas para profesionales de salud mental y educación.

---

## Índice

- [Arquitectura general](#arquitectura-general)
- [Archivos del proyecto](#archivos-del-proyecto)
- [Perfiles de usuario](#perfiles-de-usuario)
- [Módulo de chat — Aura](#módulo-de-chat--aura)
- [Sistema de memoria emocional](#sistema-de-memoria-emocional)
- [Ventana de contexto inteligente](#ventana-de-contexto-inteligente)
- [Rastreador de bienestar](#rastreador-de-bienestar)
- [Modo Profesional](#modo-profesional)
- [Modo Padres de Familia](#modo-padres-de-familia)
- [Modo Crisis](#modo-crisis)
- [Supervisión clínica](#supervisión-clínica)
- [Aviso legal](#aviso-legal)
- [PWA e instalación](#pwa-e-instalación)
- [Soporte offline](#soporte-offline)
- [Cloudflare Worker](#cloudflare-worker)
- [Rate limiting](#rate-limiting)
- [Seguridad](#seguridad)
- [Despliegue](#despliegue)
- [Variables de entorno y secrets](#variables-de-entorno-y-secrets)
- [Tecnologías utilizadas](#tecnologías-utilizadas)

---

## Arquitectura general

```
Navegador (index.html)
    │
    │  POST /chat               → conversación con Aura (streaming SSE)
    │  POST /transcribe         → transcripción de voz (Whisper)
    │  POST /extract-memory     → extracción de perfil emocional (JSON puro)
    │  POST /verify-pro         → validación de contraseña profesional
    │  POST /log-crisis         → registro anónimo de eventos de crisis
    │  POST /crisis-logs        → consulta de eventos (panel profesional)
    ▼
Cloudflare Worker (worker.js)
    │
    │  inyecta AURA_SYSTEM_PROMPT  (solo en /chat)
    │  rate limiting KV + memoria
    │  backoff exponencial en 429 / 5xx / red
    │  allowlist de modelos y campos
    ▼
Groq API (Llama 3.3 70B / fallback Llama 3.1 8B)
```

El frontend es un **Single-Page Application** puro (HTML + JS vanilla, sin frameworks). Toda la persistencia es `localStorage` del dispositivo — no hay base de datos ni servidor de sesión.

---

## Archivos del proyecto

| Archivo | Descripción |
|---|---|
| `index.html` | Aplicación completa. HTML, CSS y JS en un solo archivo. |
| `worker.js` | Cloudflare Worker: proxy seguro a Groq con 6 endpoints. |
| `sw.js` | Service Worker v2: caché PWA, network-first + offline fallback. |
| `offline.html` | Pantalla sin conexión con líneas de crisis disponibles sin internet. |
| `manifest.json` | Manifiesto PWA: iconos, shortcuts, colores, orientación. |
| `wrangler.toml` | Configuración Cloudflare (KV namespace, observabilidad). |
| `icon-192.png` | Ícono PWA 192 × 192 px. |
| `icon-512.png` | Ícono PWA 512 × 512 px. |
| `favicon.ico` | Favicon del navegador. |

---

## Perfiles de usuario

| ID | Perfil | Descripción |
|---|---|---|
| `joven` | Joven | Apoyo emocional para adolescentes y jóvenes adultos. |
| `adulto` | Adulto | Acompañamiento para adultos en crisis o malestar emocional. |
| `salud` | Profesional de salud | Herramientas clínicas. Requiere contraseña validada server-side. |
| `maestro` | Maestro / orientador | Herramientas para detección en aula. Requiere contraseña validada server-side. |
| `padres` | Padres de familia | Guía para identificar señales de riesgo en hijos. |

Los perfiles `salud` y `maestro` llaman al endpoint `/verify-pro` del worker, que compara la contraseña contra `PRO_PASSWORD_HASH` (secret cifrado en Cloudflare) con comparación en tiempo constante (XOR byte a byte) y rate limit de 5 intentos por minuto por IP.

---

## Módulo de chat — Aura

### Flujo principal (`sendMessage`)

1. Valida longitud máxima (2 000 caracteres).
2. Adjunta archivos pendientes (imágenes como base64, texto como contenido).
3. Infiere el estado de ánimo del mensaje (`inferMoodFromChat`).
4. Construye la ventana de contexto inteligente (`buildContextWindow`).
5. Llama a `callGroqStream` (streaming SSE) o `callGroq` (JSON, fallback).
6. Muestra la respuesta token a token con efecto de escritura.
7. Al completarse: ejecuta `extractAndSaveMemory()` en background y actualiza el pill de memoria.
8. Detecta palabras de crisis → activa banner o modo crisis + registra evento anónimo.

### Streaming

Usa `fetch` + `ReadableStream` para consumir eventos `data: {...}` de Groq SSE. El worker pasa el body del stream directamente al cliente sin buffering (`X-Accel-Buffering: no`).

### Entrada de voz

`startRecording()` usa `MediaRecorder` con `audio/webm`. Al soltar, `transcribeAudio()` envía el blob como `FormData` al endpoint `/transcribe` → Groq Whisper (`whisper-large-v3`).

### Text-to-Speech (TTS)

Toggle en la barra inferior del chat. `speakText()` usa la Web Speech API con voz en español si está disponible. `stopTTS()` cancela al salir del chat.

### Adjuntar archivos

Imágenes se convierten a base64 y se envían como `image_url` en mensaje multimodal. Archivos de texto / PDF se incluyen como texto en el mensaje.

### Edición del último mensaje

`editLastMessage()` restaura el texto en el input, elimina el par usuario+IA del historial y del DOM, y permite reenviarlo.

### Persistencia de sesión (con consentimiento)

El historial no se guarda automáticamente. El usuario acepta un modal de consentimiento antes de que se escriba cualquier dato. Almacenado en `localStorage` bajo `sentinelChatSession` con expiración de 7 días y máximo 30 mensajes.

### Exportar chat a PDF

`exportChatPDF()` usa **jsPDF** para generar un PDF con el historial completo.

---

## Sistema de memoria emocional

### Propósito

Aura aprende sobre la persona a lo largo de múltiples sesiones. Al terminar cada conversación, un LLM analiza el intercambio y extrae un perfil emocional estructurado. El perfil se **cifra con AES-GCM** — nunca se guarda en texto claro.

### Cifrado (AES-GCM + PBKDF2)

- Primera vez: modal de creación de PIN (mínimo 4 caracteres).
- Clave derivada con **PBKDF2-SHA256, 150 000 iteraciones**.
- `localStorage` guarda: `salt + IV + ciphertext` en base64. El PIN nunca persiste.
- Al volver: modal de desbloqueo. PIN olvidado → opción de borrar perfil.
- Datos en texto claro existentes se migran automáticamente al cifrado.
- Opción "Saltar" disponible para mantener compatibilidad sin PIN.

### Campos del perfil

| Campo | Descripción |
|---|---|
| `nombre` | Nombre de la persona (si lo menciona con certeza). |
| `miedos` | Miedos profundos identificados. |
| `inseguridades` | Inseguridades recurrentes. |
| `fortalezas` | Capacidades y resiliencia detectadas. |
| `vinculos` | Personas clave en su vida. |
| `heridas` | Heridas emocionales o temas dolorosos. |
| `acompanamiento` | Cómo prefiere ser acompañada. |
| `suenos` | Sueños y aspiraciones. |
| `triggers` | Situaciones que la desestabilizan. |
| `valores` | Valores o creencias que guían sus decisiones. |

Cada item: `{ texto: string, fecha: "YYYY-MM-DD" }`. Máximo 8 items por campo.

### Endpoint `/extract-memory`

`extractAndSaveMemory()` llama a `/extract-memory` (no `/chat`) para que el worker **no** inyecte `AURA_SYSTEM_PROMPT`. El system prompt de extracción llega intacto al modelo y devuelve JSON puro. Temperatura limitada a 0–0.5.

### Indicador visual (memory pill)

Pill en el header del chat con 3 estados:
- 🔵 **Procesando…** — spinner mientras el LLM analiza la conversación
- 🟢 **Perfil actualizado** — desaparece en 4 s
- 🟠 **No se pudo actualizar** — desaparece en 4 s

---

## Ventana de contexto inteligente

Cuando el historial supera 20 mensajes, Aura opera con **3 capas de contexto**:

```
[system: prompt de Aura]               ← identidad y comportamiento
[system: memoria emocional]            ← quién es la persona (perfil cifrado)
[system: historial de bienestar]       ← estado emocional reciente
[system: resumen comprimido]           ← qué pasó antes (generado por LLM)
[user/assistant: últimos 14 mensajes]  ← hilo inmediato
```

### Resumen comprimido (`buildContextWindow`)

- Generado con `llama-3.1-8b-instant` (modelo ligero) vía `/extract-memory`.
- Cacheado hasta que el historial crezca 4 mensajes más — sin llamadas repetidas.
- Si falla por red: truncado sin resumen como fallback, el chat no se interrumpe.
- Se limpia al iniciar nueva conversación.

| Situación | Comportamiento |
|---|---|
| ≤ 20 mensajes | Historial completo, sin resumen |
| > 20 mensajes | Resumen comprimido + últimos 14 |
| Cache válido (< 4 msgs nuevos) | Sin llamada extra al LLM |
| Fallo de red | Truncado sin resumen (fallback) |

---

## Rastreador de bienestar

Panel en la pantalla personal con selector de 5 estados de ánimo y gráfica de línea (Chart.js) de los últimos 15 días.

- `selectMood(value)` — registro manual.
- `inferMoodFromChat(userText)` — inferencia automática por LLM (1–5). Solo sobreescribe si no hay registro manual del día.
- `buildMoodContext()` — resumen en lenguaje natural de los últimos 14 días para inyectar en el chat.
- Persiste en `localStorage` bajo `sentinelMoodHistory`.

---

## Modo Profesional

Contraseña validada server-side vía `/verify-pro` — el hash nunca toca el cliente.

### Pestaña: Análisis de casos (`salud`)

- Carga CSV, Excel, TXT o imágenes (OCR vía Tesseract.js lazy-loaded).
- Clasificación por expresiones regulares: Alto / Medio / Bajo / Sin riesgo.
- Validación LLM de casos de alto riesgo en lotes de 15 (`runLLMValidation`).
- Análisis narrativo del conjunto completo (`runIAAnalysis`).
- Exportar resultados a CSV o Excel.
- Nube de palabras y gráfica de distribución (Chart.js doughnut).

### Escala Columbia (C-SSRS)

Checklist de 5 ítems. Calcula nivel de riesgo (Bajo / Moderado / Alto / Crítico) con recomendaciones de acción.

### Factores de riesgo y protección

Listas de checkboxes con conteo en tiempo real.

### Notas clínicas

Notas de sesión con fecha, nivel de riesgo, plan de acción y seguimiento. Exportables a PDF.

### Pestaña: Alerta en aula (`maestro`)

Checklist de señales observables. Calcula nivel de preocupación y sugiere protocolo. Registro de observaciones por alumno.

### Pestaña: Eventos de crisis

Panel de revisión de logs anónimos. Requiere contraseña profesional. Ver [Supervisión clínica](#supervisión-clínica).

---

## Modo Padres de Familia

Pantalla informativa con señales de alerta en semáforo, guía de conversación con hijos, recursos y líneas de crisis. Acceso al chat con Aura en modo orientado a padres.

---

## Modo Crisis

Se activa cuando Aura detecta contenido de riesgo o el usuario pulsa el botón de pánico.

- **Banner inline** con número 800 290-0024 en la burbuja de respuesta.
- **Overlay completo** con avatar de Aura, mensaje de contención y tarjetas de teléfonos:
  - CONASAMA · Línea de la Vida — 800 290-0024
  - SAPTEL — 55 5259-8121
  - DIF Nacional — 800 222-2268
  - Emergencias — 911
- Al activarse llama `logCrisisEvent()` — registra el evento de forma anónima en KV.

---

## Supervisión clínica

### Log anónimo de crisis (`/log-crisis`)

| Campo | Descripción |
|---|---|
| `timestamp` | Fecha y hora ISO 8601 |
| `perfil` | joven / adulto / padre / desconocido |
| `activado_por` | `usuario` (botón pánico) o `aura` (detección automática) |
| `fragmento` | Últimos 120 chars del mensaje del usuario |

Sin nombre, sin IP, sin datos identificables. TTL de 90 días.

### Panel de revisión (`/crisis-logs`)

Endpoint protegido con `PRO_PASSWORD_HASH`. Muestra todos los eventos ordenados por fecha. Diseñado para revisión periódica por un profesional de salud.

---

## Aviso legal

Modal de bottom sheet que aparece **una sola vez** en la primera visita. Informa que SentinelCareAI no es un servicio médico, no sustituye atención profesional, y muestra las líneas de crisis. Se guarda `sentinelLegalAccepted = '1'` en `localStorage`.

Disclaimer también visible permanentemente en la parte superior del chat.

---

## PWA e instalación

- `manifest.json` define nombre, íconos, colores, orientación y shortcuts.
- **Android**: captura `beforeinstallprompt`, muestra banner flotante.
- **iOS**: detecta Safari y muestra instrucciones manuales.
- **Escritorio**: botón discreto en el header.
- El banner se descarta por sesión (`sessionStorage`).

---

## Soporte offline

| Tipo de request | Estrategia |
|---|---|
| Proxy Groq | Siempre red — nunca cachear |
| CDN externos | Cache-first con actualización en background |
| Navegación HTML | Network-first; fallback a `offline.html` |
| Assets propios | Stale-while-revalidate |

`offline.html` se precachea en la instalación del SW e incluye las líneas de crisis disponibles sin internet.

---

## Cloudflare Worker

**URL base:** `https://sentinel-proxy.sentinelpablo.workers.dev`

### Endpoints

| Endpoint | Descripción |
|---|---|
| `POST /chat` | Chat con Aura. Inyecta `AURA_SYSTEM_PROMPT`, streaming SSE, backoff exponencial. |
| `POST /transcribe` | Reenvía audio a Groq Whisper. |
| `POST /extract-memory` | Extracción de perfil y resúmenes. No inyecta `AURA_SYSTEM_PROMPT`. Temperatura máx 0.5. |
| `POST /verify-pro` | Valida contraseña profesional. Timing-safe. Rate limit 5/min por IP. |
| `POST /log-crisis` | Registra evento de crisis anónimo en KV. Siempre responde 200. |
| `POST /crisis-logs` | Devuelve eventos de crisis. Requiere contraseña profesional. |

### Backoff exponencial

| Error | Comportamiento |
|---|---|
| 429 | Respeta `Retry-After` o espera 1s / 2s / 4s hasta 3 intentos |
| 5xx / 503 | Backoff 1s → 2s → 4s hasta 3 intentos |
| Error de red | Backoff 1s → 2s → 4s hasta 3 intentos |
| Primario agotado | Fallback a `llama-3.1-8b-instant` con misma lógica |
| Fallback agotado | Error claro al usuario |
| Stream fallido | Fallback directo sin backoff |

Espera máxima por intento: 10 s (límite del runtime de Cloudflare Workers).

---

## Rate limiting

| Endpoint | Límite |
|---|---|
| `/chat`, `/transcribe`, `/extract-memory` | 30 req/min · 500 req/día por IP |
| `/verify-pro` | 5 intentos/min por IP |

---

## Seguridad

- **CORS estricto**: solo `pablogalvan22.github.io`, `localhost` y `127.0.0.1`.
- **Security headers**: `CSP: default-src 'none'`, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- **API key nunca en el cliente**: `GROQ_API_KEY` es un Cloudflare secret cifrado.
- **System prompt cifrado**: `AURA_SYSTEM_PROMPT` también es un secret.
- **Contraseña profesional**: `PRO_PASSWORD_HASH` como secret — comparación en tiempo constante (XOR byte a byte).
- **Perfil emocional cifrado**: AES-GCM 256 bits, clave derivada por PBKDF2. Solo ciphertext en `localStorage`.
- **Allowlist de campos**: el worker solo reenvía campos permitidos a Groq.
- **Validación de input**: máx 35 mensajes por request, 8 000 chars por mensaje.
- **DOMPurify**: todo HTML de `marked.parse()` se sanitiza antes de inyectarse al DOM.
- **Log de crisis anónimo**: sin nombre, sin IP, sin datos identificables.

---

## Despliegue

```bash
# 1. Instalar Wrangler y autenticar
npm install -g wrangler
wrangler login

# 2. Configurar secrets (una sola vez)
wrangler secret put GROQ_API_KEY
wrangler secret put AURA_SYSTEM_PROMPT

# 3. Generar y subir hash de contraseña profesional
node -e "const c=require('crypto'); process.stdout.write(c.createHash('sha256').update('TU_CONTRASEÑA').digest('base64'))"
wrangler secret put PRO_PASSWORD_HASH

# 4. (Opcional) Activar KV persistente
wrangler kv:namespace create "RATE_LIMIT"
# Copiar el id al campo id en wrangler.toml → [[kv_namespaces]]

# 5. Desplegar
wrangler deploy

# 6. Publicar frontend en GitHub Pages
# Subir: index.html, sw.js, offline.html, manifest.json, icon-192.png, icon-512.png, favicon.ico
```

---

## Variables de entorno y secrets

| Nombre | Tipo | Descripción |
|---|---|---|
| `GROQ_API_KEY` | Secret Cloudflare | Clave de API de Groq. Nunca en el repositorio. |
| `AURA_SYSTEM_PROMPT` | Secret Cloudflare | System prompt completo de Aura. Cifrado en Cloudflare. |
| `PRO_PASSWORD_HASH` | Secret Cloudflare | Hash SHA-256 en base64 de la contraseña del modo profesional. |
| `ERROR_WEBHOOK_URL` | Secret Cloudflare (opcional) | Webhook para alertas de errores (Slack, Discord, Make). |
| `RATE_LIMIT_KV` | KV Binding (opcional) | Namespace KV para rate limiting persistente y logs de crisis. |

---

## Tecnologías utilizadas

| Tecnología | Uso |
|---|---|
| HTML / CSS / JS vanilla | Frontend completo — sin frameworks. |
| [Groq API](https://console.groq.com) | Inferencia LLM (Llama 3.3 70B) y transcripción (Whisper). |
| [Cloudflare Workers](https://workers.cloudflare.com) | Proxy seguro, rate limiting, secrets, logs de crisis. |
| [Cloudflare KV](https://developers.cloudflare.com/kv/) | Rate limiting persistente y eventos de crisis. |
| Web Crypto API | Cifrado AES-GCM del perfil emocional + PBKDF2. |
| [Chart.js](https://www.chartjs.org) | Gráfica de bienestar y distribución de casos. |
| [marked.js](https://marked.js.org) | Renderizado de markdown en respuestas de Aura. |
| [DOMPurify](https://github.com/cure53/DOMPurify) | Sanitización del HTML generado por marked. |
| [jsPDF](https://github.com/parallax/jsPDF) | Exportación del chat y notas clínicas a PDF. |
| [SheetJS (xlsx)](https://sheetjs.com) | Lectura de Excel y exportación de resultados. |
| [Tesseract.js](https://tesseract.projectnaptha.com) | OCR de imágenes en módulo profesional (lazy-loaded). |
| Web Speech API | Text-to-Speech de respuestas de Aura. |
| MediaRecorder API | Captura de audio para entrada de voz. |
| Service Worker + Cache API | Soporte offline y estrategias de caché PWA. |
| Web App Manifest | Instalación PWA en Android, iOS y escritorio. |
| localStorage | Perfil cifrado, bienestar, notas, sesión de chat. |
| [Playfair Display + DM Sans](https://fonts.google.com) | Tipografía (Google Fonts). |
| [Font Awesome 6](https://fontawesome.com) | Íconos de interfaz. |