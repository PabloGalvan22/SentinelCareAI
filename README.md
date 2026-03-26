# SentinelCareAI — Contigo Siempre

Plataforma de apoyo emocional y detección de riesgo con inteligencia artificial, diseñada para el contexto mexicano. Combina una IA conversacional empática (Aura) con herramientas clínicas para profesionales de salud mental y educación.

**URL:** [sentinelcareai.pages.dev](https://sentinelcareai.pages.dev)

---

## Índice

- [Arquitectura general](#arquitectura-general)
- [Archivos del proyecto](#archivos-del-proyecto)
- [Perfiles de usuario](#perfiles-de-usuario)
- [Módulo de chat — Aura](#módulo-de-chat--aura)
- [Modo de conversación por voz](#modo-de-conversación-por-voz)
- [Sistema de memoria emocional](#sistema-de-memoria-emocional)
- [Ventana de contexto inteligente](#ventana-de-contexto-inteligente)
- [Rastreador de bienestar](#rastreador-de-bienestar)
- [Notificaciones de bienestar](#notificaciones-de-bienestar)
- [Historial de sesiones](#historial-de-sesiones)
- [Modo Profesional](#modo-profesional)
- [Modo Padres de Familia](#modo-padres-de-familia)
- [Modo Crisis](#modo-crisis)
- [Supervisión clínica](#supervisión-clínica)
- [Aviso legal](#aviso-legal)
- [Accesibilidad](#accesibilidad)
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
    │  POST /token-stats        → estadísticas de consumo de tokens
    ▼
Cloudflare Worker (worker.js)
    │
    │  inyecta AURA_SYSTEM_PROMPT  (solo en /chat)
    │  rate limiting KV + memoria
    │  backoff exponencial en 429 / 5xx / red
    │  allowlist de modelos y campos
    │  log de tokens por request
    ▼
Groq API (Llama 3.3 70B / fallback Llama 3.1 8B)
```

El frontend es un **Single-Page Application** puro (HTML + JS vanilla, sin frameworks). Toda la persistencia es `localStorage` y `sessionStorage` del dispositivo — no hay base de datos ni servidor de sesión.

**Hosting:** Cloudflare Pages (auto-deploy en cada push a GitHub)
**Worker:** Cloudflare Workers

---

## Archivos del proyecto

| Archivo | Descripción |
|---|---|
| `index.html` | Aplicación completa. HTML, CSS y JS en un solo archivo. |
| `worker.js` | Cloudflare Worker: proxy seguro a Groq con 7 endpoints. |
| `sw.js` | Service Worker v4: caché PWA, network-first + offline fallback + notificationclick. |
| `offline.html` | Pantalla sin conexión con líneas de crisis disponibles sin internet. |
| `manifest.json` | Manifiesto PWA: iconos (any + maskable), shortcuts, colores, orientación. |
| `wrangler.toml` | Configuración Cloudflare (KV namespace, observabilidad). |
| `icon-192.png` | Ícono PWA 192×192 px (purpose: any). |
| `icon-512.png` | Ícono PWA 512×512 px (purpose: any). |
| `icon-192-maskable.png` | Ícono PWA 192×192 px con padding para Android adaptive icons. |
| `icon-512-maskable.png` | Ícono PWA 512×512 px maskable. |
| `favicon.ico` | Favicon multitamaño (16×16, 32×32, 48×48). |

---

## Perfiles de usuario

| ID | Perfil | Descripción |
|---|---|---|
| `personal` | Apoyo personal | Espacio seguro para hablar de cómo te sientes, sin importar edad. Aura detecta la edad en la conversación y adapta su tono automáticamente. |
| `salud` | Profesional de salud | Herramientas clínicas. Requiere contraseña validada server-side. |
| `maestro` | Maestro / orientador | Herramientas para detección en aula. Requiere contraseña validada server-side. |
| `padres` | Padres de familia | Guía para identificar señales de riesgo en hijos. |

Los perfiles `salud` y `maestro` llaman al endpoint `/verify-pro` del worker, que compara la contraseña contra `PRO_PASSWORD_HASH` (secret cifrado en Cloudflare) con comparación en tiempo constante y rate limit de 5 intentos por minuto por IP.

### Detección de edad dinámica (perfil personal)

Al recibir un mensaje del usuario, `_detectAgeFromText()` busca menciones de edad (ej: "tengo 17 años", "soy de 34"). Si detecta una edad, clasifica en `joven` (< 25) o `adulto` (≥ 25) y actualiza `_detectedAgeGroup`. A partir del siguiente mensaje, `getSystemPrompt()` usa el perfil correspondiente para que Aura adapte su tono automáticamente. Se resetea al iniciar nueva conversación.

---

## Módulo de chat — Aura

### Flujo principal (`sendMessage`)

1. Valida longitud máxima (2 000 caracteres).
2. Detecta edad del usuario (`_detectAgeFromText`).
3. Adjunta archivos pendientes (imágenes como base64, texto como contenido).
4. Infiere el estado de ánimo (`inferMoodFromChat`).
5. Construye la ventana de contexto inteligente (`buildContextWindow`).
6. Llama a `callGroqStream` (streaming SSE) o `callGroq` (JSON, fallback).
7. Muestra la respuesta token a token con efecto de escritura.
8. Al completarse: ejecuta `extractAndSaveMemory()` en background y actualiza el pill de memoria.
9. Detecta palabras de crisis → activa banner o modo crisis + registra evento anónimo.
10. En modo voz: al terminar TTS activa el micrófono automáticamente.

### Streaming

Usa `fetch` + `ReadableStream` para consumir eventos `data: {...}` de Groq SSE. El worker pasa el body del stream directamente al cliente sin buffering (`X-Accel-Buffering: no`).

### Entrada de voz

`startRecording()` usa `MediaRecorder` con `audio/webm`. Al soltar, `transcribeAudio()` envía el blob como `FormData` al endpoint `/transcribe` → Groq Whisper (`whisper-large-v3`). El texto transcrito se envía automáticamente.

### Text-to-Speech (TTS)

Toggle manual en la barra inferior del chat. `speakText()` usa la Web Speech API con selección inteligente de voz por plataforma: prioriza Paulina (iOS), Google Español (Android), Microsoft Sabina (Windows). Rate 0.92, pitch 1.0.

### Adjuntar archivos

Imágenes se convierten a base64 y se envían como `image_url`. Archivos de texto / PDF se incluyen como texto en el mensaje.

### Edición del último mensaje

`editLastMessage()` restaura el texto en el input, elimina el par usuario+IA del historial y del DOM, y permite reenviarlo.

### Exportar chat a PDF

`exportChatPDF()` usa **jsPDF** para generar un PDF con el historial completo.

---

## Modo de conversación por voz

Botón **"Modo voz"** en la barra inferior del chat. Cuando está activo:

1. El micrófono se activa inmediatamente al pulsar el botón.
2. El usuario habla → Whisper transcribe → `sendMessage()` automático.
3. Aura responde → TTS habla la respuesta.
4. Al terminar TTS → pausa 600ms → micrófono se activa solo.
5. El ciclo se repite sin tocar la pantalla.

El botón se pone verde con animación pulsante cuando está activo. Indicador "Escuchando…" con tres puntos animados mientras espera al usuario. Se desactiva automáticamente al: salir del chat, nueva conversación, modo crisis, o pulsar el botón de nuevo.

---

## Sistema de memoria emocional

### Propósito

Aura aprende sobre la persona a lo largo de múltiples sesiones. Al terminar cada conversación, un LLM analiza el intercambio y extrae un perfil emocional estructurado. El perfil se **cifra con AES-GCM** — nunca se guarda en texto claro.

### Cifrado (AES-GCM + PBKDF2)

- Primera vez: modal de creación de PIN (mínimo 4 caracteres).
- Clave derivada con **PBKDF2-SHA256, 150 000 iteraciones**, `extractable: true` cuando se necesita exportar.
- `localStorage` guarda: `salt + IV + ciphertext` en base64. El PIN nunca persiste.
- Al volver: modal de desbloqueo con selector de duración de sesión (No recordar / 1h / 4h / 8h).
- La clave se exporta a `sessionStorage` con timestamp de expiración — se borra al cerrar la pestaña.
- Al volver a abrir: si la sesión sigue válida, descifra automáticamente sin pedir el PIN.
- Datos en texto claro existentes se migran automáticamente al cifrado.

### Exportar / Importar perfil

Botón **"Exportar perfil"** descarga un archivo `.sentinelcare` con el ciphertext (ya cifrado, nunca se descifra para exportar). **"Importar perfil"** carga el archivo, pide el PIN para verificar y restaura el perfil en el nuevo dispositivo.

### Campos del perfil

| Campo | Descripción |
|---|---|
| `nombre` | Nombre de la persona. |
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

Llama a `/extract-memory` (no `/chat`) para que el worker **no** inyecte `AURA_SYSTEM_PROMPT`. El system prompt de extracción llega intacto y devuelve JSON puro. Temperatura limitada a 0–0.5.

### Indicador visual (memory pill)

Pill en el header del chat: 🔵 Procesando… / 🟢 Perfil actualizado / 🟠 No se pudo actualizar.

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

El resumen se genera con `llama-3.1-8b-instant` vía `/extract-memory`, se cachea hasta que el historial crezca 4 mensajes más, y se limpia al iniciar nueva conversación. Si falla: truncado sin resumen como fallback.

---

## Rastreador de bienestar

Panel en la pantalla personal con selector de 5 estados de ánimo y gráfica de línea (Chart.js) de los últimos 15 días.

- `selectMood(value)` — registro manual.
- `inferMoodFromChat(userText)` — inferencia automática por LLM (1–5).
- `buildMoodContext()` — resumen de los últimos 14 días para inyectar en el chat.
- Persiste en `localStorage` bajo `sentinelMoodHistory`.

---

## Notificaciones de bienestar

Toggle **"Recordatorio diario"** al final del rastreador de bienestar. Cuando está activo:

- Al abrir la app, si pasaron ≥24h desde la última notificación y el usuario no registró su ánimo hoy, aparece una notificación del sistema: **"¿Cómo estás hoy? 💚"**.
- Usa `ServiceWorkerRegistration.showNotification()` — no requiere servidor push.
- Al tocar la notificación, la app se abre o enfoca.
- Se desactiva con el mismo toggle.
- Funciona en Android (Chrome) e iOS (Safari 16.4+ con PWA instalada).

---

## Historial de sesiones

Hasta **5 conversaciones guardadas** accesibles desde el botón **"Historial"** en el header del chat. Cada sesión muestra: fecha, perfil, primeras palabras y número de mensajes.

- `saveChatSession()` — guarda la sesión actual al principio del array (con consentimiento del usuario).
- `restoreSession(id)` — carga una sesión anterior al chat.
- `deleteSession(id)` — borra una sesión individual.
- Las sesiones expiran a los 30 días.
- Las sesiones guardadas con el sistema anterior (`sentinelChatSession`) se migran automáticamente.

---

## Modo Profesional

Contraseña validada server-side vía `/verify-pro`.

### Pestaña: Análisis de casos (`salud`)

- Carga CSV, Excel, TXT o imágenes (OCR vía Tesseract.js lazy-loaded).
- Clasificación: Alto / Medio / Bajo / Sin riesgo.
- Validación LLM con barra de progreso: muestra "Analizando caso X de Y" con tiempo estimado restante y barra animada. Al terminar muestra resumen verde con totales.
- Análisis narrativo del conjunto (`runIAAnalysis`).
- Exportar a CSV o Excel.

### Escala Columbia (C-SSRS), Factores de riesgo, Notas clínicas, Observación en aula

Ver sección anterior del README para detalles.

### Pestaña: Eventos de crisis

Panel de revisión de logs anónimos. Requiere contraseña profesional.

### Pestaña: Uso de API

Estadísticas de consumo de tokens por día y por modelo. Muestra totales globales, barras de porcentaje por modelo y tabla día a día. Requiere contraseña profesional.

---

## Modo Padres de Familia

Pantalla informativa con señales de alerta en semáforo, guía de conversación con hijos, recursos y líneas de crisis. Acceso al chat con Aura en modo orientado a padres.

---

## Modo Crisis

Se activa cuando Aura detecta contenido de riesgo o el usuario pulsa el botón de pánico.

- **Banner inline** con número 800 911-2000 en la burbuja de respuesta.
- **Overlay completo** con avatar de Aura, mensaje de contención y tarjetas:
  - CONASAMA · Línea de la Vida — 800 911-2000
  - SAPTEL — 55 5259-8121
  - DIF Nacional — 800 222-2268
  - Emergencias — 911
- Al activarse llama `logCrisisEvent()` — registra el evento de forma anónima en KV.
- Salir del modo crisis también desactiva el modo voz si estaba activo.

---

## Supervisión clínica

### Log anónimo de crisis (`/log-crisis`)

| Campo | Descripción |
|---|---|
| `timestamp` | Fecha y hora ISO 8601 |
| `perfil` | personal / padre / desconocido |
| `activado_por` | `usuario` (botón pánico) o `aura` (detección automática) |
| `fragmento` | Últimos 120 chars del mensaje del usuario |

Sin nombre, sin IP. TTL de 90 días.

### Log de tokens (`/token-stats`)

Registra por cada request exitoso a `/chat` y `/extract-memory`: endpoint, modelo, prompt tokens, completion tokens, total. TTL 90 días. Protegido con contraseña profesional.

---

## Aviso legal

Modal de bottom sheet en la primera visita. Informa que SentinelCareAI no es un servicio médico. Se guarda `sentinelLegalAccepted = '1'` en `localStorage`. Disclaimer también visible en la parte superior del chat.

---

## Accesibilidad

- **Skip link** "Ir al chat" visible al presionar Tab.
- **`role` y `aria-label`** en todos los botones interactivos.
- **`aria-live`** en el contenedor de mensajes (`role="log"`), el pill de memoria (`assertive`) y el indicador de voz.
- **`aria-pressed`** en el micrófono — se actualiza dinámicamente entre "Activar micrófono" y "Detener grabación".
- **`aria-hidden="true"`** en 22+ íconos decorativos de Font Awesome.
- **`aria-haspopup="dialog"`** en el botón de pánico.
- Tarjetas de perfil navegables con Tab y activables con Enter/Espacio.

---

## PWA e instalación

- `manifest.json` con 4 iconos: `any` (192 y 512) y `maskable` (192 y 512 con padding para Android adaptive icons).
- `background_color: #0d1a2b` para splash screen consistente con el logo.
- Instalación: Android (banner), iOS (instrucciones manuales Safari), Escritorio (botón en header).
- Notificaciones push locales al abrir la app (sin servidor).

---

## Soporte offline

| Tipo de request | Estrategia |
|---|---|
| Proxy Groq | Siempre red — nunca cachear |
| CDN externos | Cache-first con actualización en background |
| Navegación HTML | Network-first; fallback a `offline.html` |
| Assets propios | Stale-while-revalidate |

Service Worker v4. `offline.html` precacheado. Incluye líneas de crisis (800 911-2000) disponibles sin internet.

---

## Cloudflare Worker

**URL base:** `https://sentinel-proxy.sentinelpablo.workers.dev`

### Endpoints

| Endpoint | Descripción |
|---|---|
| `POST /chat` | Chat con Aura. Inyecta `AURA_SYSTEM_PROMPT`, streaming SSE, backoff exponencial, log de tokens. |
| `POST /transcribe` | Reenvía audio a Groq Whisper. |
| `POST /extract-memory` | Extracción de perfil y resúmenes de contexto. No inyecta `AURA_SYSTEM_PROMPT`. Temp máx 0.5. |
| `POST /verify-pro` | Valida contraseña profesional. Timing-safe. Rate limit 5/min por IP. |
| `POST /log-crisis` | Registra evento de crisis anónimo en KV. |
| `POST /crisis-logs` | Devuelve eventos de crisis. Requiere contraseña profesional. |
| `POST /token-stats` | Estadísticas de tokens agregadas. Requiere contraseña profesional. |

### Backoff exponencial

429 / 5xx / red → 1s → 2s → 4s hasta 3 intentos → fallback a `llama-3.1-8b-instant` con misma lógica. Espera máxima: 10s.

---

## Rate limiting

| Endpoint | Límite |
|---|---|
| `/chat`, `/transcribe`, `/extract-memory` | 30 req/min · 500 req/día por IP |
| `/verify-pro` | 5 intentos/min por IP |

Híbrido KV / memoria. KV persiste entre cold starts.

---

## Seguridad

- **CORS estricto**: `pablogalvan22.github.io`, `sentinelcareai.pages.dev`, `localhost`, `127.0.0.1`.
- **Security headers**: `CSP: default-src 'none'`, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- **Secrets en Cloudflare**: `GROQ_API_KEY`, `AURA_SYSTEM_PROMPT`, `PRO_PASSWORD_HASH` — nunca en el código.
- **Perfil emocional cifrado**: AES-GCM 256 bits, PBKDF2 150k iteraciones. Solo ciphertext en `localStorage`.
- **Sesión de PIN**: clave exportada a `sessionStorage` con TTL — se borra al cerrar la pestaña.
- **Comparación en tiempo constante** (XOR byte a byte) para contraseña profesional.
- **DOMPurify** sanitiza todo HTML de `marked.parse()`.
- **Log de crisis anónimo**: sin nombre, sin IP.

---

## Despliegue

### Frontend (Cloudflare Pages)
```bash
# Auto-deploy en cada git push a la rama main
# URL: sentinelcareai.pages.dev
git add .
git commit -m "descripción del cambio"
git push
```

### Worker (Cloudflare Workers)
```bash
# Secrets (una sola vez)
wrangler secret put GROQ_API_KEY
wrangler secret put AURA_SYSTEM_PROMPT
wrangler secret put PRO_PASSWORD_HASH

# KV (una sola vez)
wrangler kv:namespace create "RATE_LIMIT"
# Copiar el id en wrangler.toml

# Desplegar
wrangler deploy
```

### Generar hash de contraseña profesional
```bash
node -e "const c=require('crypto'); process.stdout.write(c.createHash('sha256').update('TU_CONTRASEÑA').digest('base64'))"
wrangler secret put PRO_PASSWORD_HASH
```

---

## Variables de entorno y secrets

| Nombre | Tipo | Descripción |
|---|---|---|
| `GROQ_API_KEY` | Secret Cloudflare | Clave de API de Groq. |
| `AURA_SYSTEM_PROMPT` | Secret Cloudflare | System prompt completo de Aura. Cifrado en Cloudflare. |
| `PRO_PASSWORD_HASH` | Secret Cloudflare | Hash SHA-256 en base64 de la contraseña del modo profesional. |
| `ERROR_WEBHOOK_URL` | Secret Cloudflare (opcional) | Webhook para alertas de errores (Slack, Discord). |
| `RATE_LIMIT_KV` | KV Binding | Namespace KV para rate limiting, logs de crisis y tokens. |

---

## Tecnologías utilizadas

| Tecnología | Uso |
|---|---|
| HTML / CSS / JS vanilla | Frontend completo — sin frameworks. |
| [Groq API](https://console.groq.com) | Inferencia LLM (Llama 3.3 70B) y transcripción (Whisper). |
| [Cloudflare Pages](https://pages.cloudflare.com) | Hosting del frontend con auto-deploy desde GitHub. |
| [Cloudflare Workers](https://workers.cloudflare.com) | Proxy seguro, rate limiting, secrets, logs. |
| [Cloudflare KV](https://developers.cloudflare.com/kv/) | Rate limiting persistente, crisis logs y token stats. |
| Web Crypto API | Cifrado AES-GCM del perfil emocional + PBKDF2. |
| Web Speech API | TTS con selección inteligente de voz por plataforma. |
| MediaRecorder API | Captura de audio para entrada de voz. |
| Service Worker + Cache API | Soporte offline, caché PWA y notificationclick. |
| Web App Manifest | PWA instalable con iconos `any` y `maskable`. |
| Notification API | Recordatorios de bienestar locales (sin servidor push). |
| [Chart.js](https://www.chartjs.org) | Gráfica de bienestar y distribución de casos. |
| [marked.js](https://marked.js.org) | Renderizado de markdown en respuestas de Aura. |
| [DOMPurify](https://github.com/cure53/DOMPurify) | Sanitización del HTML generado por marked. |
| [jsPDF](https://github.com/parallax/jsPDF) | Exportación del chat y notas clínicas a PDF. |
| [SheetJS (xlsx)](https://sheetjs.com) | Lectura de Excel y exportación de resultados. |
| [Tesseract.js](https://tesseract.projectnaptha.com) | OCR de imágenes en módulo profesional (lazy-loaded). |
| localStorage / sessionStorage | Perfil cifrado, bienestar, notas, sesiones, PIN cacheado. |
| [Playfair Display + DM Sans](https://fonts.google.com) | Tipografía (Google Fonts). |
| [Font Awesome 6](https://fontawesome.com) | Íconos de interfaz. |