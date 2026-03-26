# SentinelCareAI — Contigo Siempre

Plataforma de apoyo emocional y detección de riesgo con inteligencia artificial, diseñada para el contexto mexicano. Combina una IA conversacional empática (Aura) con herramientas clínicas para profesionales de salud mental y educación.

---

## Índice

- [Arquitectura general](#arquitectura-general)
- [Archivos del proyecto](#archivos-del-proyecto)
- [Perfiles de usuario](#perfiles-de-usuario)
- [Módulo de chat — Aura](#módulo-de-chat--aura)
- [Sistema de memoria emocional](#sistema-de-memoria-emocional)
- [Rastreador de bienestar](#rastreador-de-bienestar)
- [Modo Profesional](#modo-profesional)
- [Modo Padres de Familia](#modo-padres-de-familia)
- [Modo Crisis](#modo-crisis)
- [PWA e instalación](#pwa-e-instalación)
- [Soporte offline](#soporte-offline)
- [Cloudflare Worker (proxy)](#cloudflare-worker-proxy)
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
    │  POST /chat             → conversación con Aura (streaming SSE)
    │  POST /transcribe       → transcripción de voz (Whisper)
    │  POST /extract-memory   → extracción de perfil emocional (JSON puro)
    ▼
Cloudflare Worker (worker.js)
    │
    │  inyecta AURA_SYSTEM_PROMPT  (solo en /chat)
    │  rate limiting KV + memoria
    │  allowlist de modelos y campos
    ▼
Groq API (Llama 3.3 70B / fallback Llama 3.1 8B)
```

El frontend es un **Single-Page Application** puro (HTML + JS vanilla, sin frameworks). Toda la persistencia es `localStorage` del dispositivo del usuario — no hay base de datos ni servidor de sesión.

---

## Archivos del proyecto

| Archivo | Descripción |
|---|---|
| `index.html` | Aplicación completa (~7 100 líneas). Contiene HTML, CSS y JS. |
| `worker.js` | Cloudflare Worker: proxy seguro a Groq con rate limiting. |
| `sw.js` | Service Worker v2: caché PWA, estrategia network-first + offline fallback. |
| `offline.html` | Pantalla de sin conexión con líneas de crisis disponibles sin internet. |
| `manifest.json` | Manifiesto PWA: iconos, shortcuts, colores, orientación. |
| `wrangler.toml` | Configuración de despliegue Cloudflare (KV namespace, observabilidad). |
| `icon-192.png` | Ícono PWA 192 × 192 px. |
| `icon-512.png` | Ícono PWA 512 × 512 px. |
| `favicon.ico` | Favicon del navegador. |

---

## Perfiles de usuario

La landing presenta cinco perfiles, cada uno con un system prompt y UI adaptados:

| ID | Perfil | Descripción |
|---|---|---|
| `joven` | Joven | Apoyo emocional para adolescentes y jóvenes adultos. |
| `adulto` | Adulto | Acompañamiento para adultos en crisis o malestar emocional. |
| `salud` | Profesional de salud | Herramientas clínicas. Requiere contraseña. |
| `maestro` | Maestro / orientador | Herramientas para detección en aula. Requiere contraseña. |
| `padres` | Padres de familia | Guía para identificar señales de riesgo en hijos. |

Los perfiles `salud` y `maestro` pasan por `verifyProAccess()`, que compara un hash SHA-256 de la contraseña ingresada contra `_PRO_HASH` (hardcoded en el cliente — cambiar en producción por validación server-side si se requiere mayor seguridad).

---

## Módulo de chat — Aura

### Flujo principal (`sendMessage`)

1. Valida longitud máxima (2 000 caracteres).
2. Adjunta archivos pendientes (imágenes como base64, texto como contenido).
3. Infiere el estado de ánimo del mensaje (`inferMoodFromChat`) — llamada ligera al LLM que devuelve un valor 1–5.
4. Llama a `callGroqStream` (streaming SSE) o `callGroq` (JSON, fallback sin streaming).
5. Muestra la respuesta token a token con efecto de escritura.
6. Al completarse: ejecuta `extractAndSaveMemory()` en background.
7. Detecta palabras de crisis en la respuesta → activa banner o modo crisis completo.

### Streaming (`callGroqStream`)

Usa `fetch` + `ReadableStream` para consumir los eventos `data: {...}` de Groq SSE. Cada chunk se parsea y el delta de texto se agrega al burbuja activa del chat. El worker pasa el body del stream directamente al cliente sin buffering (`X-Accel-Buffering: no`).

### Entrada de voz

- Botón de micrófono → `startRecording()` usa `MediaRecorder` con `audio/webm`.
- Al soltar: `transcribeAudio()` envía el blob como `FormData` al endpoint `/transcribe` del worker.
- El worker lo reenvía a Groq Whisper (`whisper-large-v3`) y devuelve el texto transcrito.
- El texto se inserta en el input de chat listo para enviar.

### Text-to-Speech (TTS)

- Toggle en la barra inferior del chat.
- `speakText()` usa la Web Speech API (`speechSynthesis`).
- Selecciona automáticamente una voz en español si está disponible.
- `stopTTS()` cancela cualquier utterance en curso (se llama al salir del chat o iniciar nueva conversación).

### Adjuntar archivos

- Imágenes: se convierten a base64 y se envían como `image_url` en el mensaje multimodal (requiere modelo con visión: `llama-3.2-11b-vision-preview` o `llama-3.2-90b-vision-preview`).
- Archivos de texto / PDF: el contenido se extrae y se incluye como texto en el mensaje.
- Se muestra un chip de preview por cada archivo adjunto con botón de eliminar.

### Edición del último mensaje

`editLastMessage()` permite modificar el último mensaje enviado: restaura el texto en el input, elimina el par usuario+IA del historial y del DOM, y vuelve a enviarlo al guardar.

### Persistencia de sesión (con consentimiento)

El historial **no se guarda automáticamente**. El usuario debe pulsar "Guardar" y aceptar el modal de consentimiento. Se almacena en `localStorage` bajo `sentinelChatSession` con expiración de 7 días y máximo 30 mensajes. El borrado es inmediato desde "Nueva conversación".

### Exportar chat a PDF

`exportChatPDF()` usa **jsPDF** para generar un PDF con el historial completo de la conversación, incluyendo metadatos de fecha y perfil.

---

## Sistema de memoria emocional

### Propósito

Aura aprende sobre la persona a lo largo de múltiples sesiones. Al terminar cada conversación, un LLM analiza el intercambio y extrae un perfil emocional estructurado guardado en `localStorage`.

### Campos del perfil

| Campo | Descripción |
|---|---|
| `nombre` | Nombre de la persona (si lo menciona con certeza). |
| `miedos` | Miedos profundos identificados. |
| `inseguridades` | Inseguridades recurrentes. |
| `fortalezas` | Capacidades y resiliencia detectadas. |
| `vinculos` | Personas clave en su vida y la naturaleza del vínculo. |
| `heridas` | Heridas emocionales o temas que le causan dolor. |
| `acompanamiento` | Cómo prefiere ser acompañada (necesita escucha, rechaza consejos, etc.). |
| `suenos` | Sueños y aspiraciones mencionados. |
| `triggers` | Situaciones que la desestabilizan emocionalmente. |
| `valores` | Valores o creencias que guían sus decisiones. |

Cada item se almacena como `{ texto: string, fecha: "YYYY-MM-DD" }`. Máximo 8 items por campo; si se llena, se reemplaza el más antiguo o superficial.

### Flujo técnico (`extractAndSaveMemory`)

1. Solo corre si hay al menos 2 mensajes y hay conexión.
2. Evita re-extraer si el historial no cambió (hash por longitud + último texto).
3. Construye un `systemPrompt` con criterios estrictos de qué merece recordarse.
4. Llama al endpoint **`/extract-memory`** (no `/chat`) para que el worker **no** inyecte `AURA_SYSTEM_PROMPT` — el modelo recibe el prompt de extracción puro y devuelve JSON.
5. Parsea el JSON, normaliza items (agrega fecha de hoy a strings nuevos), fusiona con el perfil existente y lo guarda.

> **Bug corregido:** antes se llamaba a `/chat`, que filtraba el system prompt del cliente y lo reemplazaba con el de Aura. El modelo respondía en lenguaje natural, `JSON.parse` fallaba silenciosamente y el perfil nunca se actualizaba.

### Panel "Lo que Aura recuerda de ti"

`renderMemoryPreview()` muestra el perfil guardado agrupado por campo con íconos y fechas. El usuario puede borrarlo con `confirmClearMemory()`. El panel está en la pantalla de perfil personal (`#s-personal`) y se recarga cada vez que se abre.

### Contexto de memoria en el chat

`buildMemoryContext()` genera un bloque de texto estructurado con el perfil y lo inyecta al inicio del historial de mensajes que se envía a Aura, para que "recuerde" a la persona desde el primer mensaje de cada sesión.

---

## Rastreador de bienestar

Panel en la pantalla personal con selector de estado de ánimo (5 niveles: 😔 Muy mal → 😊 Muy bien) y gráfica de línea (Chart.js) de los últimos 15 días.

- `selectMood(value)` — registra el estado manualmente.
- `inferMoodFromChat(userText)` — el LLM infiere el estado a partir del mensaje (valor 1–5). Solo sobreescribe si no hay registro manual del día.
- `updateMoodSourceBadge()` — muestra si el dato del día fue manual o inferido por IA.
- `buildMoodContext()` — genera un resumen en lenguaje natural del historial emocional de los últimos 14 días para incluirlo como contexto en el chat.
- Los datos se persisten en `localStorage` bajo `sentinelMoodHistory`.

---

## Modo Profesional

Disponible para perfiles `salud` (psicólogos, médicos) y `maestro` (orientadores educativos). Protegido por contraseña.

### Pestaña: Análisis de casos (`salud`)

- Carga archivos CSV, Excel (`.xlsx`), o imágenes con texto (OCR vía Tesseract.js lazy-loaded).
- `handleProFiles()` detecta el tipo de archivo y lo procesa.
- Selector de columna para identificar cuál contiene el texto a analizar.
- `analyzeFile()` clasifica cada caso con expresiones regulares en niveles de riesgo: **Alto**, **Medio**, **Bajo**, **Sin riesgo**.
- Métricas en tiempo real: total de casos, alertas altas, posibles falsos positivos.
- Tabla de resultados filtrable con colores por nivel de riesgo.
- Nube de palabras de los términos más frecuentes (`updateWordCloud`).
- Gráfica de distribución por nivel (Chart.js doughnut).
- Exportar resultados a **CSV** o **Excel (.xlsx)**.

### Validación LLM de casos de alto riesgo (`runLLMValidation`)

- Toma los casos clasificados como "Alto" (hasta `LLM_BATCH_SIZE = 15` por lote).
- Llama al LLM para que evalúe cada caso: confirma o descarta el riesgo con justificación.
- Muestra en la tabla si el LLM coincide o difiere de la clasificación por reglas.
- `runIAAnalysis()` genera un análisis narrativo del conjunto completo de casos.

### Escala Columbia (C-SSRS) (`salud`)

Checklist de la Columbia Suicide Severity Rating Scale con 5 ítems. `updateColumbiaScore()` calcula el nivel de riesgo (Bajo / Moderado / Alto / Crítico) según los ítems seleccionados y muestra recomendaciones de acción.

### Factores de riesgo y protección (`salud`)

Dos listas de checkboxes (factores de riesgo / factores protectores). `toggleCheckFactor()` actualiza el conteo en tiempo real.

### Notas clínicas (`salud`)

`saveNote()` guarda notas de sesión con fecha, nivel de riesgo, plan de acción y seguimiento en `localStorage` (`sentinel_notes`). `renderNotesLog()` muestra el historial. `exportNotes()` genera un PDF con todas las notas.

### Pestaña: Alerta en aula (`maestro`)

Checklist de señales de alerta observables en el aula (conductas, cambios de ánimo, aislamiento, etc.). `updateClassroomScore()` calcula un nivel de preocupación y sugiere el protocolo de acción. `saveStudentNote()` registra observaciones por alumno.

---

## Modo Padres de Familia

Pantalla informativa (`#s-padres`) con:

- Señales de alerta organizadas en semáforo (verde / amarillo / rojo).
- Guía de cómo iniciar una conversación con un hijo.
- Recursos y líneas de crisis.
- Acceso al chat con Aura en modo "padre", con un system prompt adaptado para orientar a padres preocupados por sus hijos.

---

## Modo Crisis

Se activa cuando el LLM detecta contenido de riesgo inmediato en la respuesta de Aura.

- **Banner de crisis**: barra fija en la parte inferior con el número 800 290-0024 (CONASAMA).
- **Overlay de crisis completo** (`openCrisisMode`): pantalla completa con avatar de Aura, mensaje de contención y tarjetas de teléfonos de emergencia:
  - CONASAMA · Línea de la Vida — 800 290-0024
  - SAPTEL — 55 5259-8121
  - DIF Nacional — 800 222-2268
  - Emergencias — 911
- `closeCrisisMode()` regresa al chat y empuja un estado al historial del navegador para que el botón "atrás" lo cierre correctamente.

---

## PWA e instalación

La app es una Progressive Web App instalable en Android, iOS y escritorio.

- `manifest.json` define nombre, íconos, colores, orientación y dos shortcuts (Chat de apoyo, Líneas de crisis).
- El Service Worker (`sw.js`) se registra al cargar y habilita el uso offline.
- Lógica de instalación en `index.html`:
  - **Android**: captura `beforeinstallprompt`, muestra banner flotante (`showInstallBanner`).
  - **iOS**: detecta Safari en iPhone/iPad y muestra instrucciones manuales (Compartir → Añadir a inicio).
  - **Escritorio**: botón discreto en el header (`_showDesktopInstallBtn`).
- `installApp()` dispara el prompt nativo o muestra las instrucciones según la plataforma.
- El banner se descarta por sesión (`sessionStorage`).

---

## Soporte offline

El Service Worker (`sw.js`) implementa cuatro estrategias según el tipo de recurso:

| Tipo de request | Estrategia |
|---|---|
| Proxy Groq (`sentinel-proxy.*.workers.dev`) | Siempre red — nunca cachear. |
| CDN externos (fonts, Chart.js, marked…) | Cache-first con actualización en background. |
| Navegación HTML | Network-first; fallback a `offline.html` si no hay red. |
| Assets propios (JS/CSS/imágenes) | Stale-while-revalidate. |

`offline.html` se **precachea en la instalación** del SW para garantizar que siempre esté disponible. Si el precacheo falla (primer despliegue sin red), el SW devuelve una respuesta HTML mínima inline con los números de crisis.

Al volver online, `updateOnlineStatus()` oculta el banner de sin conexión y reactiva el envío normal.

---

## Cloudflare Worker (proxy)

**Archivo:** `worker.js`  
**URL base:** `https://sentinel-proxy.sentinelpablo.workers.dev`

### Endpoints

#### `POST /chat`
Chat con Aura. El worker:
1. Filtra todos los mensajes `system` del cliente.
2. Prepende `AURA_SYSTEM_PROMPT` (desde secret cifrado).
3. Valida modelo (allowlist), temperatura (0–1.5), max_tokens (1–2 000).
4. Soporta streaming SSE (`stream: true`).
5. Fallback automático: si el modelo primario devuelve 5xx o falla la red, reintenta con `llama-3.1-8b-instant`.

#### `POST /transcribe`
Transcripción de audio. Reenvía el `FormData` con el audio a Groq Whisper (`whisper-large-v3`) y devuelve el texto.

#### `POST /extract-memory`
Extracción de perfil emocional. **No inyecta `AURA_SYSTEM_PROMPT`**: pasa los mensajes tal cual para que el system prompt de extracción (JSON puro) llegue intacto al modelo. Temperatura limitada a 0–0.5 para resultados deterministas.

### Modelos permitidos

```
llama-3.3-70b-versatile   ← primario
llama-3.1-8b-instant      ← fallback
llama-3.2-11b-vision-preview
llama-3.2-90b-vision-preview
mixtral-8x7b-32768
gemma2-9b-it
whisper-large-v3
```

---

## Rate limiting

Implementación híbrida: usa **Cloudflare KV** si el binding `RATE_LIMIT_KV` está configurado; si no, cae a **memoria en proceso** (best-effort, se reinicia con el worker).

| Límite | Valor |
|---|---|
| Por minuto por IP | 30 requests |
| Por día por IP | 500 requests |

Las claves KV expiran automáticamente (`expirationTtl`). Si KV falla por cualquier razón, el worker continúa usando memoria sin romper el request.

**Para activar KV persistente:**
```bash
wrangler kv:namespace create "RATE_LIMIT"
# Pegar el id devuelto en wrangler.toml → [[kv_namespaces]]
wrangler deploy
```

---

## Seguridad

- **CORS estricto**: solo se responde con `Access-Control-Allow-Origin` a orígenes en `ALLOWED_ORIGINS` (localhost, GitHub Pages). Otros orígenes reciben la respuesta sin el header CORS — el navegador la bloquea.
- **Security headers** en todas las respuestas: `CSP: default-src 'none'`, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- **API key nunca en el cliente**: `GROQ_API_KEY` es un Cloudflare secret cifrado, inaccesible desde el navegador o el repositorio.
- **System prompt cifrado**: `AURA_SYSTEM_PROMPT` también es un secret — no está en el código fuente ni en los logs.
- **Allowlist de campos**: el worker solo reenvía a Groq los campos `model`, `messages`, `temperature`, `max_tokens` y `stream`. Cualquier otro campo del cliente se descarta.
- **Validación de input**: máximo 35 mensajes por request y 8 000 caracteres por mensaje.
- **DOMPurify**: todo HTML generado por `marked.parse()` (markdown de Aura) se sanitiza antes de inyectarse al DOM.
- **Error webhook opcional**: si se configura `ERROR_WEBHOOK_URL` (secret), los errores de Groq se envían a Slack/Discord sin bloquear la respuesta al usuario.

---

## Despliegue

### Prerrequisitos

- Cuenta en [Cloudflare](https://cloudflare.com) (plan gratuito es suficiente).
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) instalado.
- Clave de API de [Groq](https://console.groq.com).

### Pasos

```bash
# 1. Instalar Wrangler
npm install -g wrangler
wrangler login

# 2. Configurar secrets (una sola vez)
wrangler secret put GROQ_API_KEY
wrangler secret put AURA_SYSTEM_PROMPT

# 3. (Opcional) Activar rate limiting persistente con KV
wrangler kv:namespace create "RATE_LIMIT"
# Copiar el id al campo id en wrangler.toml → [[kv_namespaces]]

# 4. Desplegar el worker
wrangler deploy

# 5. Publicar el frontend
# Subir index.html, sw.js, offline.html, manifest.json,
# icon-192.png, icon-512.png, favicon.ico a GitHub Pages
# (o cualquier hosting estático).
```

### Actualizaciones posteriores

Solo el archivo modificado necesita actualizarse:

```bash
# Cambios en el worker
wrangler deploy

# Cambios en el frontend
# Subir los archivos modificados a GitHub Pages / hosting estático
# y hacer bump de CACHE_NAME en sw.js si cambian assets cacheados
```

---

## Variables de entorno y secrets

| Nombre | Tipo | Descripción |
|---|---|---|
| `GROQ_API_KEY` | Secret Cloudflare | Clave de API de Groq. Nunca en el repositorio. |
| `AURA_SYSTEM_PROMPT` | Secret Cloudflare | System prompt completo de Aura. Cifrado en Cloudflare. |
| `ERROR_WEBHOOK_URL` | Secret Cloudflare (opcional) | URL de webhook para recibir alertas de errores de Groq (Slack, Discord, Make). |
| `RATE_LIMIT_KV` | KV Binding (opcional) | Namespace de Cloudflare KV para rate limiting persistente. |

---

## Tecnologías utilizadas

| Tecnología | Uso |
|---|---|
| HTML / CSS / JS vanilla | Frontend completo — sin frameworks. |
| [Groq API](https://console.groq.com) | Inferencia LLM (Llama 3.3 70B) y transcripción (Whisper). |
| [Cloudflare Workers](https://workers.cloudflare.com) | Proxy seguro, rate limiting, gestión de secrets. |
| [Cloudflare KV](https://developers.cloudflare.com/kv/) | Rate limiting persistente entre instancias del worker. |
| [Chart.js](https://www.chartjs.org) + chartjs-plugin-datalabels | Gráfica de bienestar emocional y distribución de casos. |
| [marked.js](https://marked.js.org) | Renderizado de markdown en respuestas de Aura. |
| [DOMPurify](https://github.com/cure53/DOMPurify) | Sanitización del HTML generado por marked. |
| [jsPDF](https://github.com/parallax/jsPDF) | Exportación del chat y notas clínicas a PDF. |
| [SheetJS (xlsx)](https://sheetjs.com) | Lectura de archivos Excel y exportación de resultados. |
| [Tesseract.js](https://tesseract.projectnaptha.com) | OCR de imágenes en el módulo profesional (lazy-loaded). |
| Web Speech API | Text-to-Speech de respuestas de Aura. |
| MediaRecorder API | Captura de audio para entrada de voz. |
| Service Worker + Cache API | Soporte offline y estrategias de caché PWA. |
| Web App Manifest | Instalación PWA en Android, iOS y escritorio. |
| localStorage | Perfil emocional, historial de bienestar, notas clínicas, sesión de chat. |
| [Playfair Display + DM Sans](https://fonts.google.com) | Tipografía (Google Fonts). |
| [Font Awesome 6](https://fontawesome.com) | Íconos de interfaz. |