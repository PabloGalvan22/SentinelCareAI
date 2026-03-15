# SentinelCareAI — Contigo Siempre

> Plataforma PWA de apoyo emocional y detección de riesgo con inteligencia artificial.
> Diseñada para el contexto hispanohablante mexicano.

![Versión](https://img.shields.io/badge/versión-2.2-teal)
![PWA](https://img.shields.io/badge/PWA-ready-blue)
![Modelo](https://img.shields.io/badge/modelo-Llama%203.3%2070B-orange)
![Offline](https://img.shields.io/badge/offline-compatible-green)

---

# SentinelCareAI — Contigo Siempre

> Apoyo emocional con inteligencia artificial, detección de riesgo y acompañamiento personalizado. Todo local, todo privado.

---

## ¿Qué es SentinelCareAI?

SentinelCareAI es una Progressive Web App (PWA) de apoyo emocional y salud mental impulsada por IA. Su núcleo es **Aura**, una presencia cálida y empática que acompaña a las personas en conversaciones difíciles, aprende de cada persona a lo largo del tiempo y adapta su forma de interactuar según quién está al otro lado.

El proyecto tiene dos grandes áreas:

- **Área personal** — para usuarios individuales (jóvenes, adultos, padres/madres) que buscan apoyo emocional.
- **Área profesional** — para profesionales de salud mental y educadores, con herramientas de análisis de riesgo, evaluación clínica y detección de señales de alerta.

---

## Estructura del proyecto

```
SentinelCareAI/
├── index.html          # App completa (SPA — todo en un solo archivo)
├── manifest.json       # Configuración PWA
├── sw.js               # Service Worker (caché offline)
├── offline.html        # Pantalla sin conexión con líneas de crisis
├── worker.js           # Cloudflare Worker — proxy seguro hacia Groq
├── wrangler.toml       # Configuración de despliegue del Worker
├── favicon.ico
├── icon-192.png
└── icon-512.png
```

---

## Pantallas de la aplicación

| ID | Pantalla | Descripción |
|----|----------|-------------|
| `s-landing` | Inicio | Selección de perfil |
| `s-personal` | Personal | Dashboard para jóvenes y adultos |
| `s-padres` | Padres | Guía para padres y madres |
| `s-chat` | Chat | Conversación con Aura |
| `s-pro-access` | Acceso profesional | Pantalla de contraseña |
| `s-professional` | Panel profesional | Herramientas clínicas y educativas |

---

## Perfiles de usuario

### 👤 Joven
- Tono espontáneo e informal, como un hermano mayor de confianza
- Valida emociones sin minimizarlas
- Entiende presión académica, redes sociales, identidad, relaciones
- Primer mensaje: empático y sin protocolos

### 👤 Adulto
- Tono sereno y reflexivo, sin condescendencia
- Reconoce el peso de las responsabilidades
- Entiende duelo, relaciones de pareja, pérdida de rumbo, agotamiento
- No infantiliza, confía en la madurez de la persona

### 👤 Padre / Madre
- Valida primero el miedo y el amor detrás de la preocupación
- Orienta sin culpar
- Detecta señales de alerta en los hijos y orienta hacia recursos
- Recuerda que el padre también necesita ser escuchado

Cada perfil tiene su propio **prompt de sistema** (`getSystemPrompt()`) y su propio **primer mensaje** (`initChat()`), completamente diferenciados.

---

## Aura — El chatbot

### Motor
- **Modelo principal:** `llama-3.3-70b-versatile` vía Groq
- **Modelo de inferencia ligera:** `llama-3.1-8b-instant` (tareas rápidas en segundo plano)
- **Transcripción de voz:** Whisper `whisper-large-v3-turbo`

### Capacidades del chat
- Respuestas empáticas adaptadas al perfil activo
- Soporte para texto, imágenes y archivos adjuntos
- Entrada por voz (STT con Groq Whisper)
- Lectura en voz alta de respuestas (TTS con Web Speech API)
- Renderizado de Markdown en las respuestas de Aura
- Detección automática de palabras de crisis con banner de líneas de ayuda
- Contador de caracteres (límite 2,000)
- Indicador de escritura animado
- Reintento automático ante errores de red (hasta 3 intentos)

### Exportación
- Exportar conversación como **PDF** con formato visual completo (jsPDF)

### Persistencia de sesión
- El historial **no se guarda automáticamente**
- El usuario puede guardarlo manualmente con consentimiento explícito
- Se guarda en `localStorage` con clave `sentinelChatSession`
- Auto-expira a los 7 días sin actividad
- Máximo 30 mensajes almacenados

---

## Memoria persistente local — "Lo que Aura sabe de ti"

Aura aprende de cada persona a lo largo del tiempo. Todo se guarda **únicamente en el dispositivo** con `localStorage`. Ningún servidor recibe este dato.

### Cómo funciona

1. **Al salir del chat** → `extractAndSaveMemory()` analiza la conversación silenciosamente y extrae lo importante usando `llama-3.1-8b-instant`
2. **Al iniciar el chat** → `buildMemoryContext()` inyecta el perfil guardado como contexto adicional para Aura
3. **En cada mensaje** → Aura recibe el perfil y lo usa de forma natural, como lo haría un amigo que te conoce

### Qué guarda (solo lo que realmente importa)

| Categoría | Ejemplos |
|-----------|---------|
| `miedos` | "Teme que si muestra vulnerabilidad la rechacen" |
| `inseguridades` | "Cree que no es suficientemente inteligente para lo que sueña" |
| `fortalezas` | "Tiene una capacidad notable para levantarse después de caer" |
| `heridas` | "Creció sintiendo que sus emociones eran una carga para su familia" |
| `vinculos` | "Su relación con su madre es fuente de dolor y amor al mismo tiempo" |
| `acompanamiento` | "Necesita sentirse escuchada antes de recibir cualquier consejo" |

### Qué NO guarda
- Hechos del día sin peso emocional ("tuvo un examen", "fue al gimnasio")
- Datos superficiales ("le gusta el café", "estudia medicina")
- Nada que no ayude a acompañar mejor en el largo plazo

### Límites
- Máximo **5 items por categoría** (solo los más significativos)
- Los datos más viejos se reemplazan si hay algo más relevante
- Sin fecha de expiración fija — el perfil crece con la persona

### Control del usuario
- Tarjeta visual "Lo que Aura recuerda de ti" en la pantalla personal
- Botón **Borrar memoria** con confirmación — borra todo de forma irrevocable
- Borrar conversación **no borra la memoria** (son dos cosas independientes)

---

## Rastreador de bienestar emocional

Gráfica de línea que muestra el estado emocional de los últimos 7 días.

### Dos formas de actualizar

**👆 Registro manual** — el usuario toca uno de los 5 emojis (Muy bien → Muy mal). Siempre tiene prioridad absoluta.

**💬 Detección automática del chat** — después de cada mensaje, `inferMoodFromChat()` hace una llamada silenciosa con `llama-3.1-8b-instant` y estima el estado emocional en escala 1-5. Si ya hay un registro manual hoy, no lo toca. Si hay una inferencia previa, la promedia suavemente (60% viejo / 40% nuevo).

### Diferenciación visual en la gráfica
- 🟢 **Punto verde sólido** = registrado manualmente por el usuario
- ⭕ **Punto hueco teal** = detectado automáticamente del chat
- Tooltip muestra la fuente al tocar cada punto
- Leyenda aparece automáticamente cuando hay datos inferidos

### Badge de estado
Debajo de los emojis aparece un badge que indica:
- *"Detectado por Aura en el chat: Regular · Toca un emoji para corregir"*
- *"Registrado por ti: Bien"*

### Persistencia
- `localStorage` con clave `sentinelMoodHistory`
- Historial ilimitado de días

---

## Panel Profesional

Accesible con contraseña. Dos modos según el perfil:

### 🩺 Profesional de Salud
- **Análisis de texto masivo** — carga CSV/XLSX/TXT con mensajes de pacientes
- **Motor de palabras clave** de riesgo con puntuación por severidad
- **Validación por LLM** — segunda capa automática para casos ALTO/EXTREMO (lotes de 15)
- **Niveles de riesgo:** Nulo / Bajo / Medio / Alto / Extremo / Ambigüedad Médica
- **Escala Columbia** — checklist interactivo de evaluación de riesgo suicida
- **Factores de riesgo y protección** — checklists clínicos
- **Notas clínicas** — registro por sesión con exportación CSV
- **Nube de palabras** de términos críticos detectados
- **Gráfica de distribución** de niveles de riesgo
- **Palabras más frecuentes** (top 10, barras horizontales)
- **OCR** — extracción de texto desde imágenes con Tesseract.js

### 🏫 Maestro / Educador
- **Checklist de observación en aula** — 14 indicadores con peso ponderado
- **Puntuación automática** con nivel de alerta y acción recomendada
- **Protocolos de actuación** paso a paso
- **Notas de alumnos** — registro anónimo por grupo
- **Chat con Aura** en modo educativo
- **Recursos de derivación** para Guanajuato

---

## Pantalla de Padres

- Semáforo de señales de alerta (rojo / naranja / verde)
- Acordeón con guías de conversación
- Scripts de diálogo sugeridos
- Recursos de apoyo locales (Guanajuato)
- Chat con Aura en modo orientación para padres

---

## Botón de pánico — Modo Crisis

Botón flotante visible en **todas las pantallas** en todo momento.

Al tocarlo, abre un overlay de pantalla completa con:
- Mensaje de contención de Aura
- Tres tarjetas de llamada directa con un toque:
  - **800 290-0024** — CONASAMA / Línea de la Vida (24 hrs, gratuita)
  - **55 5259-8121** — SAPTEL (confidencial, 24 hrs)
  - **800 222-2268** — DIF Nacional (24 hrs, gratuita)

---

## Pantalla offline

Si el dispositivo pierde conexión, el Service Worker sirve `offline.html` con:
- Mensaje de contención
- Las mismas líneas de crisis como enlaces `tel:` (funcionan sin internet)
- Botón para reintentar conexión

---

## Proxy — Cloudflare Worker

`worker.js` actúa como intermediario entre el frontend y la API de Groq. **La API key nunca llega al navegador.**

### Endpoints
| Ruta | Método | Función |
|------|--------|---------|
| `/chat` | POST | Chat completions (Llama vía Groq) |
| `/transcribe` | POST | Transcripción de audio (Whisper vía Groq) |

### Seguridad
- **CORS** — lista blanca de orígenes autorizados
- **Allowlist de modelos** — solo modelos aprobados pueden usarse
- **Límites de parámetros** — `temperature` (0–1.5), `max_tokens` (1–2,000)
- **Filtro de system prompt** — el worker elimina cualquier `role: system` que venga del cliente e inyecta el prompt autoritativo del servidor
- **Rate limiting en memoria:**
  - Máx. 30 requests / minuto por IP
  - Máx. 500 requests / día por IP
  - Responde con `429` y cabecera `Retry-After`

### Despliegue
```bash
# Instalar Wrangler
npm install -g wrangler

# Autenticarse
wrangler login

# Agregar la API key como secret (nunca en wrangler.toml)
wrangler secret put GROQ_API_KEY

# Desplegar
wrangler deploy
```

---

## PWA — Progressive Web App

| Característica | Detalle |
|----------------|---------|
| Instalable | Android (banner nativo), iOS (instrucciones), Desktop (botón flotante) |
| Modo offline | Service Worker con estrategia network-first + fallback a caché |
| Precaché | `index.html`, `manifest.json`, `offline.html` |
| Tema | `#3d7a8a` |
| Orientación | Portrait primary |
| Display | Standalone |
| Idioma | Español (`es`) |
| Shortcuts | "Chat de apoyo", "Líneas de crisis" |

### Estrategias de caché (sw.js)
- **Proxy Groq** → siempre network, nunca cachear
- **CDN externos** → cache-first con actualización en background
- **Assets propios** → network-first con fallback a caché
- **Navegación sin red** → devuelve `offline.html`

---

## Navegación con botón "atrás" del sistema operativo

Implementado con `history.pushState` en cada transición de pantalla y `window.addEventListener('popstate', ...)` para interceptar el gesto nativo del celular.

| Pantalla actual | Comportamiento del "atrás" |
|-----------------|---------------------------|
| Chat | Abre el modal "Antes de irte…" |
| Personal / Padres / Pro-Access / Profesional | Regresa a la landing |
| Landing | El navegador sale normalmente |
| Crisis overlay o modales abiertos | Los cierra primero |

---

## Modo oscuro

- Toggle disponible en todas las pantallas con header
- Preferencia guardada en `localStorage` (`sentinelDark`)
- Se restaura automáticamente al recargar
- La gráfica de bienestar se actualiza al cambiar de modo

---

## Librerías externas

| Librería | Versión | Uso |
|----------|---------|-----|
| Chart.js | latest | Gráfica de bienestar y análisis profesional |
| chartjs-plugin-datalabels | 2 | Etiquetas en gráficas del panel profesional |
| marked | latest | Renderizado de Markdown en respuestas de Aura |
| DOMPurify | 3.1.6 | Sanitización del HTML generado por marked |
| jsPDF | 2.5.1 | Exportación de conversaciones a PDF |
| Font Awesome | 6.5.0 | Íconos |
| Google Fonts | — | Playfair Display + DM Sans |
| SheetJS (xlsx) | 0.18.5 | Lectura de archivos Excel en el panel profesional |
| WordCloud2.js | 1.0.2 | Nube de palabras de riesgo |
| Tesseract.js | latest | OCR de imágenes en el panel profesional |

> Las librerías pesadas (xlsx, WordCloud2, Tesseract) se cargan **bajo demanda** solo cuando el usuario accede al panel profesional, para no afectar el tiempo de carga inicial.

---

## localStorage — Claves utilizadas

| Clave | Contenido | Cuándo se borra |
|-------|-----------|-----------------|
| `sentinelUserMemory` | Perfil emocional de Aura | Botón "Borrar memoria" |
| `sentinelMoodHistory` | Historial de bienestar | Manual (no hay botón de borrado aún) |
| `sentinelChatSession` | Última conversación guardada | "Nueva conversación" o modal de salida |
| `sentinelDark` | Preferencia de modo oscuro | Nunca (preferencia permanente) |
| `sentinelNotes` | Notas clínicas (profesional) | Botón "Borrar registros" |
| `sentinelStudentNotes` | Notas de alumnos (educador) | Manual |

---

## Variables de configuración rápida

```js
// index.html
const PROXY_BASE_URL   = 'https://sentinel-proxy.sentinelpablo.workers.dev';
const GROQ_MODEL       = 'llama-3.3-70b-versatile';
const WHISPER_MODEL    = 'whisper-large-v3-turbo';
const CHAT_MAX_DAYS    = 7;    // días antes de expirar sesión guardada
const CHAT_MAX_MESSAGES = 30;  // mensajes máximos en historial guardado

// Memoria de Aura
const MEMORY_KEY       = 'sentinelUserMemory';

// worker.js
const RL_MAX_MINUTE    = 30;   // requests por minuto por IP
const RL_MAX_DAY       = 500;  // requests por día por IP
```

---

## Despliegue en GitHub Pages

1. Sube todos los archivos al repositorio
2. Activa GitHub Pages desde **Settings → Pages → Deploy from branch → main**
3. Actualiza `PROXY_BASE_URL` en `index.html` con la URL de tu Worker desplegado
4. Agrega tu dominio de GitHub Pages a `ALLOWED_ORIGINS` en `worker.js`

---

## Privacidad

- **Sin cuentas, sin registro, sin tracking**
- La conversación con Aura pasa por el Worker (Cloudflare) hacia Groq — el Worker no almacena nada
- La memoria, el historial de bienestar y las sesiones de chat se guardan **solo en el dispositivo del usuario** con `localStorage`
- El PDF de conversación se genera completamente en el dispositivo — no se sube a ningún servidor
- El usuario puede borrar toda su memoria en cualquier momento desde la interfaz

---

## Líneas de crisis disponibles en la app

| Línea | Número | Descripción |
|-------|--------|-------------|
| CONASAMA — Línea de la Vida | 800 290-0024 | Crisis emocional y suicidio · Gratuita · 24 hrs |
| SAPTEL | 55 5259-8121 | Apoyo emocional · Confidencial · 24 hrs |
| DIF Nacional | 800 222-2268 | Violencia familiar y apoyo · Gratuita · 24 hrs |
| Emergencias | 911 | Riesgo inmediato |

---

*Desarrollado con ❤️ para acompañar a las personas en su camino hacia el bienestar emocional.*
