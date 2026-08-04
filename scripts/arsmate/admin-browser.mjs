#!/usr/bin/env node
/**
 * arsmate-admin-browser.mjs
 * Abre un navegador (Chrome) e intercepta las llamadas a la API de autenticación
 * para simular que el usuario es administrador.
 *
 * Uso:
 *   node scripts/arsmate-admin-browser.mjs
 *   node scripts/arsmate-admin-browser.mjs --url https://arsmate.com/otra-ruta
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';
import { URL } from 'node:url';

// ─── Credenciales (Copiadas de arsmate-proxy.mjs) ───────────────────────────
const ARSMATE_EMAIL    = "m45942076@gmail.com";
const ARSMATE_PASSWORD = "minasricas00";
const ARSMATE_BASE     = "https://arsmate.com";
let sessionCookie = null;
let myUserId      = null;
let sessionToken  = null; // token de sesión que el SPA guarda en sessionStorage
let rawSetCookies = []; // Set-Cookie crudos capturados del login por API

// ─── Login ───────────────────────────────────────────────────────────────────
// Idempotente: aunque se llame varias veces (arranque del proxy, IIFE, lazy en
// getSecureImage), la autenticación real se ejecuta una sola vez.
let loginPromise = null;
function login() {
  if (!loginPromise) loginPromise = doLogin();
  return loginPromise;
}

async function doLogin() {
  console.log("🔑 Autenticando en arsmate.com (API)...");
  try {
    const res = await fetch(`${ARSMATE_BASE}/api/auth/login`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":   "Mozilla/5.0",
        "Origin":       ARSMATE_BASE,
        "Referer":      `${ARSMATE_BASE}/login`,
      },
      body: JSON.stringify({ email: ARSMATE_EMAIL, password: ARSMATE_PASSWORD }),
      redirect: "manual",
    });

    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length > 0) {
      rawSetCookies = setCookies;
      sessionCookie = setCookies.map(c => c.split(";")[0]).join("; ");
    }

    let body = {};
    try { body = await res.json(); } catch { /* no JSON */ }

    if (body.user?.id) myUserId = String(body.user.id);
    if (body.sessionToken) sessionToken = body.sessionToken;

    if (!sessionCookie) {
      console.error(`❌ Login fallido (API) HTTP ${res.status}:`, body);
    } else {
      console.log(`✅ Login exitoso (API). userId=${myUserId}`);
    }
  } catch (err) {
    console.error("❌ Error en login (API):", err);
  }
}

// Convierte un header Set-Cookie ("name=value; Path=/; HttpOnly; ...") en el
// objeto que espera context.addCookies() de Playwright.
function parseSetCookie(cookieStr) {
  const [nameValue, ...attrs] = cookieStr.split(";").map(s => s.trim());
  const eq = nameValue.indexOf("=");
  const cookie = {
    name:  nameValue.slice(0, eq),
    value: nameValue.slice(eq + 1),
    url:   ARSMATE_BASE,
  };

  for (const attr of attrs) {
    const idx = attr.indexOf("=");
    const key = (idx === -1 ? attr : attr.slice(0, idx)).toLowerCase();
    const val = idx === -1 ? "" : attr.slice(idx + 1);

    if (key === "path") cookie.path = val;
    else if (key === "domain") cookie.domain = val.replace(/^\./, "");
    else if (key === "expires") cookie.expires = Math.floor(new Date(val).getTime() / 1000);
    else if (key === "max-age") cookie.expires = Math.floor(Date.now() / 1000) + parseInt(val, 10);
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "secure") cookie.secure = true;
    else if (key === "samesite" && val) cookie.sameSite = val.charAt(0).toUpperCase() + val.slice(1).toLowerCase();
  }

  // Playwright prohíbe combinar `url` con `domain`/`path`: exige `url` SOLO, o
  // bien el par `domain`+`path` SIN `url`.
  if (cookie.domain) {
    // Caso domain+path: soltamos url y garantizamos path.
    delete cookie.url;
    if (!cookie.path) cookie.path = '/';
  } else {
    // Caso url: el propio url ya implica dominio y path, así que NO podemos
    // mandar `path` (daría "Cookie should have either url or path").
    delete cookie.path;
  }
  return cookie;
}

// ─── Obtener secureUrl ───────────────────────────────────────────────────────
/*
async function getSecureUrl(postId, mediaId, userId) {
  if (!sessionCookie) await login();

  // IMPORTANTE: Para reproducir contenido de otro usuario, userId en el body 
  // debe ser el ID DEL DUEÑO DEL POST (el creador), no mi propio ID.
  // El script original usaba `userId ?? myUserId`, lo cual funciona para mis posts,
  // pero para ver posts de otros, debemos enviar el ID del creador.
  const targetUserId = userId || myUserId;

  const body = { userId: targetUserId, postId: String(postId) };
  if (mediaId) body.mediaId = String(mediaId);

  console.log(`Generating token for post=${postId} media=${mediaId} user=${targetUserId}`);
  const res = await fetch(`${ARSMATE_BASE}/api/video/generate-token`, {
    method:  "POST",
    headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
        "Referer":    `${ARSMATE_BASE}/`,
        "Origin":     ARSMATE_BASE,
        "Cookie":     sessionCookie
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  console.log(`[generate-token] response for post=${postId}:`, JSON.stringify(data)); // DEBUG
  if (!data.success) throw new Error(data.message ?? data.error ?? `generate-token falló (${res.status})`);
  
  // Manejar respuesta legacy/publica vs secure
  const finalUrl = data.secureUrl || data.videoUrl;
  if (!finalUrl) throw new Error("No secureUrl or videoUrl in response");

  return { jwt: data.token, secureUrl: finalUrl };
}
*/

// ─── Obtener secureUrl para IMAGEN ─────────────────────────────────────────
async function getSecureImage(postId, mediaId, userId) {
  if (!sessionCookie) await login();
  const targetUserId = userId || myUserId;

  const body = { userId: targetUserId, postId: String(postId) };
  if (mediaId) body.mediaId = String(mediaId);

  console.log(`Generating IMAGE token for post=${postId} media=${mediaId} user=${targetUserId}`);
  
  // Asumimos que el endpoint es /api/image/generate-token
  const res = await fetch(`${ARSMATE_BASE}/api/image/generate-token`, {
    method:  "POST",
    headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
        "Referer":    `${ARSMATE_BASE}/`,
        "Origin":     ARSMATE_BASE,
        "Cookie":     sessionCookie
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  console.log(`[generate-token-image] response for post=${postId}:`, JSON.stringify(data)); // DEBUG
  if (!data.success) throw new Error(data.message ?? data.error ?? `generate-token-image falló (${res.status})`);
  
  // Posibles campos: secureUrl, imageUrl, url...
  const finalUrl = data.secureUrl || data.imageUrl || data.url;
  if (!finalUrl) throw new Error("No secureUrl/imageUrl in response for image");

  return { jwt: data.token, secureUrl: finalUrl };
}

// ─── ALMACEN DE TOKENS (POST_ID -> TOKEN_ID) ────────────────────────────────
const postTokens = new Map();
// ─── DUEÑO DEL POST (POST_ID -> CREATOR USER_ID) ────────────────────────────
// El path del CDN /media-public/videos/<creatorId>/... necesita el ID del
// CREADOR, no el del viewer que el frontend manda en generate-token.
const postOwners = new Map();

// ─── Proxy Interno para HLS ──────────────────────────────────────────────────
const INTERNAL_PROXY_PORT = 9999;
const proxyServer = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${INTERNAL_PROXY_PORT}`);
  const pathname = u.pathname;
  const query = Object.fromEntries(u.searchParams);
  
  // ─── Route: /register-token ──────────────────────────────────────────────
  if (pathname === '/register-token') {
    const { postId, token } = query;
    if (postId && token) {
        console.log(`[Proxy] Registered token_id for post ${postId}`);
        postTokens.set(String(postId), token);
    }
    // Respond with 200 and CORS headers
    res.writeHead(200, { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'image/gif'
    });
    // Return a 1x1 transparent GIF to satisfy the img tag
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.end(gif);
    return;
  }

  // ─── Route: /play (video proxy) ──────────────────────────────────────────
  if (u.pathname === '/play') {
    const postId = u.searchParams.get("postId");
    const mediaId = u.searchParams.get("mediaId");
    let userId    = u.searchParams.get("userId");
    const token   = u.searchParams.get("token");

    // Red de seguridad: el path del CDN necesita el ID del CREADOR. Si conocemos
    // el dueño del post (capturado del feed) lo usamos sí o sí, ignorando el
    // userId que pueda venir mal en la URL (el frontend manda el del viewer).
    const ownerId = postId ? postOwners.get(String(postId)) : null;
    if (ownerId) userId = ownerId;

    if (!userId || !mediaId) {
      res.writeHead(400);
      res.end('Missing userId or mediaId');
      return;
    }

    // El espejo /media-public sirve el HLS sin token (incluso para contenido
    // de suscripción). NO redirigimos directo al CDN porque hls.js corre en el
    // origen arsmate.com y fallaría por CORS, y las URLs relativas del manifest
    // (media-1/stream.m3u8, media.ts) no se reescribirían.
    //
    // En su lugar mandamos el master al route /manifest, que proxya, reescribe
    // las URLs internas para que pasen por este proxy, y agrega los headers CORS.
    const masterUrl = `https://video-proxy.aroman-4f3.workers.dev/media-public/videos/${userId}/${mediaId}/hls/master.m3u8`;
    const proxiedUrl = `http://localhost:${INTERNAL_PROXY_PORT}/manifest?url=${encodeURIComponent(masterUrl)}`;
    console.log(`[Proxy] /play -> manifest proxy for ${userId}/${mediaId}`);
    res.writeHead(302, { Location: proxiedUrl });
    res.end();
    return;
  }

  // Endpoint principal IMAGEN: /image
  if (u.pathname === "/image") {
    const postId  = u.searchParams.get("postId");
    const mediaId = u.searchParams.get("mediaId");
    const userId  = u.searchParams.get("userId");

    if (!postId || !mediaId) {
      res.writeHead(400); res.end("Missing params"); return;
    }

    try {
      const { secureUrl } = await getSecureImage(postId, mediaId, userId);
      // Redirigir a la URL real firmada. 
      // Si requiere cookies/headers especiales, tendríamos que proxyar el contenido igual que en /manifest.
      // Probemos primero con redirección directa (302). Si falla por CORS/Auth, usaremos proxy.
      // Arsmate suele usar URLs firmadas que funcionan por sí solas.
      res.writeHead(302, { Location: secureUrl });
      res.end();
    } catch (err) {
      console.error("Proxy Image Error:", err.message);
      res.writeHead(500); res.end(err.message);
    }
    return;
  }

  // Endpoint manifiesto/segmentos
  if (u.pathname === "/manifest" || u.pathname.endsWith(".m3u8") || u.pathname.endsWith(".ts") || u.pathname.endsWith(".key")) {
    const targetUrl = u.searchParams.get("url");
    if (!targetUrl) { res.writeHead(400); res.end("Missing url param"); return; }

    try {
      // Reenviar el header Range del navegador (los segmentos usan
      // #EXT-X-BYTERANGE; sin esto bajaríamos el archivo completo de ~150MB
      // por cada segmento y el player no podría cortar los rangos).
      const upstreamHeaders = {
          "User-Agent": "Mozilla/5.0",
          "Referer": "https://arsmate.com/",
          "Origin": "https://arsmate.com"
      };
      if (req.headers["range"]) upstreamHeaders["Range"] = req.headers["range"];

      // Fetch al recurso real
      const proxyRes = await fetch(targetUrl, { headers: upstreamHeaders });

      const contentType = proxyRes.headers.get("content-type") || "";
      const isManifest = contentType.includes("mpegurl") || targetUrl.includes(".m3u8");

      // Copiar headers relevantes
      const headers = {};
      if (proxyRes.headers.has("content-type")) headers["content-type"] = proxyRes.headers.get("content-type");
      headers["access-control-allow-origin"] = "*"; // CORS para el navegador
      headers["access-control-allow-headers"] = "*";
      headers["access-control-expose-headers"] = "content-length, content-range, accept-ranges";

      if (isManifest) {
        // El manifest reescrito cambia de tamaño: NO reenviar content-length.
        const text = await proxyRes.text();
        const baseUrl = new URL(targetUrl);
        const basePath = baseUrl.href.substring(0, baseUrl.href.lastIndexOf("/") + 1);

        const rewriteAbs = (rel) => {
            const absUrl = rel.startsWith("http") ? rel : new URL(rel, basePath).href;
            return `http://localhost:${INTERNAL_PROXY_PORT}/manifest?url=${encodeURIComponent(absUrl)}`;
        };

        const rewritten = text
            // URIs dentro de tags (#EXT-X-KEY, #EXT-X-I-FRAME-STREAM-INF, #EXT-X-MAP)
            .replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${rewriteAbs(uri)}"`)
            // Líneas que no son comentarios (variantes y segmentos)
            .replace(/^(?!#)(.+)$/gm, (match) => rewriteAbs(match));

        res.writeHead(proxyRes.status, headers);
        res.end(rewritten);
      } else {
        // Stream binario (segmentos TS, keys, etc.) — preservar Range/206
        if (proxyRes.headers.has("content-length")) headers["content-length"] = proxyRes.headers.get("content-length");
        if (proxyRes.headers.has("content-range")) headers["content-range"] = proxyRes.headers.get("content-range");
        if (proxyRes.headers.has("accept-ranges")) headers["accept-ranges"] = proxyRes.headers.get("accept-ranges");
        res.writeHead(proxyRes.status, headers); // 206 si vino Range
        const arrayBuffer = await proxyRes.arrayBuffer();
        res.end(Buffer.from(arrayBuffer));
      }

    } catch (err) {
      console.error("Proxy Resource Error:", err);
      res.writeHead(500); res.end("Proxy error");
    }
    return;
  }

  res.writeHead(404); res.end("Not found");
});

proxyServer.listen(INTERNAL_PROXY_PORT, () => {
    console.log(`🎧 Proxy interno escuchando en http://localhost:${INTERNAL_PROXY_PORT}`);
    // Iniciar login al arrancar
    login();
});


// Rutas comunes de Chrome en macOS
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const executablePath = CHROME_PATHS.find(path => fs.existsSync(path));

if (!executablePath) {
  console.error('❌ No se encontró Google Chrome instalado en las rutas estándar.');
  console.error('Por favor, instala Google Chrome o ajusta la ruta en el script.');
  process.exit(1);
}

// URL objetivo por defecto
const TARGET_URL = process.argv.find(arg => arg.startsWith('http')) || 'https://arsmate.com/Katie69';

// Los lives usan Agora RTC (WebRTC con token firmado del lado servidor), no HLS
// del CDN. No hay nada que desbloquear interceptando: forzar tokens falsos solo
// hace que Agora rechace la conexión. Para estas URLs dejamos pasar TODO el
// tráfico sin tocarlo y omitimos la inyección de scripts en la página.
const IS_LIVE = /\/live\//.test(TARGET_URL);
// const USER_ID_ARG = process.argv.find(arg => arg.startsWith('--userId='));
const USER_ID = '2879295';

// Datos de usuario Admin simulado
const MOCK_ADMIN_USER = {
  success: true,
  user: {
    id: USER_ID,
    username: "admin",
    email: "admin@arsmate.com",
    role: "admin",
    isAdmin: true,
    verified: true,
    premium: true
  }
};

(async () => {
  console.log(`🚀 Lanzando Chrome desde: ${executablePath}`);
  
  const browser = await chromium.launch({
    executablePath,
    headless: false,
    args: [
      '--start-maximized',
      '--auto-open-devtools-for-tabs', // Abrir DevTools (equivalente a devtools: true)
      '--disable-web-security', // Útil para evitar algunos problemas de CORS si modificamos respuestas
      '--disable-features=IsolateOrigins,site-per-process',
      '--remote-debugging-port=9222', // Habilitar depuración remota para herramientas MCP
      '--allow-running-insecure-content', // Permitir Mixed Content (HTTP en HTTPS)
      '--ignore-certificate-errors', // Permitir certificados autofirmados (para proxy HTTPS local)
      '--allow-insecure-localhost'
    ]
  });

  // Contexto del navegador. En Playwright la sesión (cookies, init scripts,
  // viewport) vive en el contexto, no en el browser.
  //  - viewport: null      -> equivalente a defaultViewport: null (usa la ventana)
  //  - bypassCSP: true      -> evita blocked:csp al cargar http://localhost:9999/...
  //  - ignoreHTTPSErrors    -> certificados autofirmados del proxy HTTPS local
  const context = await browser.newContext({
    viewport: null,
    bypassCSP: true,
    ignoreHTTPSErrors: true,
  });

  // Inject helper script to force video playback if needed
  // Use addInitScript to ensure it runs before any other script
  const page = await context.newPage();

  // Desactivar el caché HTTP vía CDP: si no, al navegar dentro de la SPA Chrome
  // sirve /api/posts/feed desde caché (la versión BLOQUEADA) sin pasar por
  // nuestro interceptor. Esto garantiza que cada feed se desbloquee de nuevo.
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.setCacheDisabled', { cacheDisabled: true });

  // Listen for console logs
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('🔥') || text.includes('[Injector]')) {
        console.log(`[PAGE] ${text}`);
    }
  });

  if (!IS_LIVE) await page.addInitScript(() => {
    window.PROXY_PORT = 9999;
    window._videoMap = {}; // postId -> videoUrl
    console.log("🔥 [Injector] Starting Arsmate Proxy Helper v4 (Persistent)");

    // Override fetch to capture responses
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const url = args[0] instanceof Request ? args[0].url : args[0];
        
        if (url && typeof url === 'string' && url.includes('/api/posts/feed')) {
            const clone = response.clone();
            clone.json().then(data => {
                console.log("🔥 [Injector] Intercepted feed response", data);
                const posts = data.data?.posts || data.posts || [];
                
                // Save posts globally for inspection
                window._posts = window._posts || {};
                posts.forEach(p => {
                    if (p.token_id) {
                         console.log(`🔥 [Injector] Registering token for post ${p.id}`);
                    }
                    if (p.media) {
                        console.log(`🔥 [DATA] Post ${p.id} Media: ${JSON.stringify(p.media)}`);
                        // Force unlock
                        p.media.requiresToken = false;
                        if (p.media.thumbnail && p.media.thumbnail.includes('video-proxy')) {
                             // Guess m3u8
                             const m3u8 = p.media.thumbnail.replace('thumbnail.jpg', 'master.m3u8');
                             
                             // If content is Public, we MUST go through the proxy to get a signed token?
                             // No, previously we tried to go through proxy and it failed because we didn't have a token.
                             // But now we know DIRECT access also fails.
                             // So we MUST generate a token.
                             // But generate-token endpoint requires a session cookie.
                             // We don't have a session cookie for the USER's browser session in our Node script?
                             // Yes, the browser has the cookie!
                             
                             // So, we should NOT force the URL to the direct CDN link.
                             // Instead, we should let the frontend call `generate-token`.
                             // BUT `generate-token` might fail if the user is not logged in?
                             // Wait, Katie69 is public. A logged-out user can see it.
                             // So `generate-token` should work for public posts even without a subscription?
                             // Let's try to restore the original behavior for Public posts: don't touch them!
                             
                             // If we remove the "requiresToken=false" flag, the frontend will try to call `generate-token`.
                             // If that succeeds, it gets a valid URL.
                             // If we force "requiresToken=false", the frontend tries to play `media.url` directly.
                             // And if we set `media.url` to the CDN link, it fails 403.
                             
                             // So the fix is: DO NOT TOUCH Public posts. Let the site handle them.
                             // Only interfere with LOCKED posts.
                             
                             if (p.contentType === "Público" || p.price === 0 || p.isPublic) {
                                 console.log(`🔥 [Injector] Skipping public post ${p.id} (letting site handle token)`);
                                 // Do NOT set requiresToken=false
                                 // Do NOT set videoUrl
                                 return;
                             }
                             
                             // For LOCKED posts that we are "unlocking":
                             // We can't generate a token because we don't have a sub.
                             // We have the token_id, but that doesn't help with the CDN.
                             // So for these, we are still stuck.
                             
                             p.media.hlsManifestUrl = m3u8;
                             p.media.videoUrl = m3u8;
                             p.media.url = m3u8;
                             p.media.requiresToken = false; // Disable frontend token check
                             console.log(`🔥 [Injector] Force-unlocking video URL: ${m3u8}`);
                        } else if (p.media.type === 'video' && p.media.id) {
                             // Fix (paridad con feed.ts / interceptor Node): video gateado
                             // SIN thumbnail 'video-proxy' no debe quedar sin fuente. En vez
                             // de gatear por la URL base, derivamos la URL del proxy local
                             // desde el mediaId (siempre presente), igual que hacemos para
                             // videos con URL. Así no cae al candado "Contenido Exclusivo".
                             if (p.contentType === "Público" || p.price === 0 || p.isPublic) {
                                 return;
                             }
                             const proxyUrl = `http://localhost:${window.PROXY_PORT}/play?postId=${p.id}&mediaId=${p.media.id}&userId=${p.user_id}`;
                             p.media.hlsManifestUrl = proxyUrl;
                             p.media.videoUrl = proxyUrl;
                             p.media.url = proxyUrl;
                             p.media.src = proxyUrl;
                             console.log(`🔥 [Injector] Force-unlocking video (por mediaId): ${proxyUrl}`);
                        }
                    }
                    if (p.mediaItems) {
                        p.mediaItems.forEach(m => {
                            // Same logic for items
                            if (p.contentType === "Público" || p.price === 0 || p.isPublic) {
                                return;
                            }

                            m.requiresToken = false;
                            if (m.thumbnail && m.thumbnail.includes('video-proxy')) {
                                const m3u8 = m.thumbnail.replace('thumbnail.jpg', 'master.m3u8');
                                m.hlsManifestUrl = m3u8;
                                m.videoUrl = m3u8;
                                m.url = m3u8;
                                m.src = m3u8;
                                console.log(`🔥 [Injector] Force-unlocking video item: ${m3u8}`);
                            } else if (m.type === 'video' && m.id) {
                                // Fix: mismo criterio que arriba, pero para cada item de video
                                // sin thumbnail utilizable → derivar del mediaId.
                                const proxyUrl = `http://localhost:${window.PROXY_PORT}/play?postId=${p.id}&mediaId=${m.id}&userId=${p.user_id}`;
                                m.hlsManifestUrl = proxyUrl;
                                m.videoUrl = proxyUrl;
                                m.url = proxyUrl;
                                m.src = proxyUrl;
                                console.log(`🔥 [Injector] Force-unlocking video item (por mediaId): ${proxyUrl}`);
                            }
                        });
                    }
                });

                posts.forEach(p => {
                    // SKIP PUBLIC POSTS FOR VIDEOMAP TOO
                    if (p.contentType === "Público" || p.price === 0 || p.isPublic) {
                         return;
                    }

                    let proxyUrl = p.media?.videoUrl || p.video?.videoUrl;
                    
                    // Fallback para videoUrl en mediaItems
                    if (!proxyUrl) {
                        // Buscar en media.mediaItems
                        if (p.media && p.media.mediaItems && p.media.mediaItems.length > 0) {
                            const v = p.media.mediaItems.find(m => m.type === 'video');
                            if (v && v.id) {
                                const mediaId = v.id;
                                const userId = p.user_id;
                                const postId = p.id;
                                proxyUrl = `http://localhost:9999/play?postId=${postId}&mediaId=${mediaId}&userId=${userId}`;
                            }
                        }
                        
                        // Buscar en p.mediaItems directo
                        if (!proxyUrl && p.mediaItems && p.mediaItems.length > 0) {
                            const v = p.mediaItems.find(m => m.type === 'video');
                            if (v && v.id) {
                                const mediaId = v.id;
                                const userId = p.user_id;
                                const postId = p.id;
                                proxyUrl = `http://localhost:9999/play?postId=${postId}&mediaId=${mediaId}&userId=${userId}`;
                            }
                        }
                    }

                    if (proxyUrl) {
                        window._videoMap[p.id] = proxyUrl;
                        console.log(`🔥 [VideoMap] Saved ${p.id} -> ${proxyUrl}`);
                    }
                });
            }).catch(e => console.error("🔥 [Injector] Error parsing feed", e));
        }
        return response;
    };
    
    // 2. Observer para inyectar src en videos huerfanos (Agresivo)
    setInterval(() => {
        // Buscar cualquier video en la página
        document.querySelectorAll('video').forEach(v => {
            // Si el video no tiene src válido, intentamos inferir qué post es
            if (!v.src || v.src.startsWith('blob:') || v.src === window.location.href) {
                // Buscar el ancestro más cercano que parezca un post
                let parent = v.closest('article') || v.closest('.post-card') || v.closest('div[id^="post-"]');
                let postId = null;

                if (parent) {
                    // Estrategias para encontrar ID
                    // 1. data-post-id
                    postId = parent.getAttribute('data-post-id');
                    
                    // 2. Links internos
                    if (!postId) {
                        const link = parent.querySelector('a[href*="/posts/"]');
                        if (link) {
                            const match = link.href.match(/\/posts\/(\d+)/);
                            if (match) postId = match[1];
                        }
                    }
                } else {
                    // Si no encontramos padre, intentamos buscar texto cercano que parezca una fecha o ID
                    // O simplemente iteramos sobre todos los videos y les asignamos URLs del mapa en orden? (Peligroso)
                }

                if (postId && window._videoMap[postId]) {
                    const proxyUrl = window._videoMap[postId];
                    if (v.src !== proxyUrl) {
                        console.log(`[Injector] Forcing src for post ${postId}: ${proxyUrl}`);
                        
                        // Detener cualquier carga actual
                        v.pause();
                        v.removeAttribute('src');
                        v.load();
                        
                        // Asignar nuevo src
                        v.src = proxyUrl;
                        v.load();
                        
                        // Intentar play suave
                        // v.play().catch(() => {});
                    }
                }
            }
        });
    }, 1000);

    // 3. Monitor de estado de videos
    setInterval(() => {
        const videos = document.querySelectorAll('video');
        if (videos.length > 0) {
            console.log(`[VideoMonitor] Found ${videos.length} videos`);
            videos.forEach((v, i) => {
                console.log(`[VideoMonitor] Video ${i}: src="${v.src}" paused=${v.paused} readyState=${v.readyState} error=${v.error ? v.error.message : 'null'}`);
            });
        } else {
             console.log(`[VideoMonitor] No videos found yet...`);
        }
    }, 2000);

  });
  
  // Intercept requests (Playwright usa page.route en vez de setRequestInterception)

     // ALMACEN DE TOKENS (POST_ID -> TOKEN_ID)
     // const postTokens = new Map(); // Already defined globally

     // Debug: Log all network responses to analyze token_id usage
    const logStream = fs.createWriteStream('network_full.jsonl', { flags: 'w' });
    
    page.on('response', async (response) => {
        const url = response.url();
        const request = response.request();
        // Log everything except data: and obvious static assets if you want, but user said ALL.
        // Let's exclude data: images to keep size manageable.
        if (url.startsWith('data:')) return;

        try {
            const status = response.status();
            const headers = response.headers();
            let body = '[Binary/Large]';
            
            const contentType = headers['content-type'] || '';
            if (contentType.includes('application/json') || contentType.includes('text/') || contentType.includes('xml')) {
                try {
                    body = await response.text();
                } catch (e) {
                    body = '[Error reading body]';
                }
            }
            
            const entry = JSON.stringify({
                url,
                method: request.method(),
                status,
                headers,
                body: body.length > 5000 ? body.substring(0, 5000) + '...' : body
            });
            logStream.write(entry + '\n');
        } catch (e) {
            // Ignore
        }
    });

  await page.route('**/*', async (route, request) => {
    const url = request.url();

    // Para lives no modificamos nada: dejamos pasar cada request tal cual.
    if (IS_LIVE) { route.continue(); return; }

    // Interceptar llamada a /api/auth/me
    if (url.includes('/api/auth/me')) {
      console.log(`🔥 Interceptado: ${url} -> Respondiendo como ADMIN (Merge)`);
      
      try {
        const reqHeaders = { ...request.headers() };
        delete reqHeaders['host'];

        const proxied = await fetch(url, {
          method: request.method(),
          headers: reqHeaders,
        });

        const data = await proxied.json();

        // Mezclar datos: mantener respuesta original pero imponer valores de admin
        if (data.user) {
            Object.assign(data.user, MOCK_ADMIN_USER.user);
        } else {
            data.user = MOCK_ADMIN_USER.user;
        }
        data.success = true;

        route.fulfill({
          status: proxied.status,
          contentType: 'application/json',
          body: JSON.stringify(data),
          headers: {
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (err) {
        console.error('❌ Error interceptando /api/auth/me, usando fallback:', err);
        // Fallback si falla el fetch original
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(MOCK_ADMIN_USER),
            headers: {
            'Access-Control-Allow-Origin': '*'
            }
        });
      }
      return;
    }

    // Interceptar llamada a /api/baul/carpetas -> reemplazar usuarioId por 2879295
    if (url.includes('/api/baul/carpetas')) {
      const parsedUrl = new URL(url);
      parsedUrl.searchParams.set('usuarioId', '2879295');
      const newUrl = parsedUrl.toString();
      console.log(`🔥 Interceptado: ${url} -> Redirigiendo a ${newUrl}`);

      try {
        const reqHeaders = { ...request.headers() };
        delete reqHeaders['host'];

        const proxied = await fetch(newUrl, {
          method: request.method(),
          headers: reqHeaders,
        });

        const data = await proxied.json();

        route.fulfill({
          status: proxied.status,
          contentType: 'application/json',
          body: JSON.stringify(data),
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        console.error('❌ Error interceptando /api/baul/carpetas:', err);
        route.continue();
      }
      return;
    }

    // Interceptar llamada a /api/maintenance/status
    if (url.includes('/api/maintenance/status')) {
      console.log(`🔥 Interceptado: ${url} -> Respondiendo MAINTENANCE STATUS (Admin Bypass)`);
      
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ 
          success: true, 
          maintenance: false,
          user: MOCK_ADMIN_USER.user, // Incluir usuario admin por si acaso
          isAdmin: true 
        }),
        headers: {
          'Access-Control-Allow-Origin': '*'
        }
      });
      return;
    }

    // Interceptar llamada a /api/subscriptions/check
    if (url.includes('/api/subscriptions/check')) {
      console.log(`🔥 Interceptado: ${url} -> Respondiendo SUBSCRIPTION CHECK (Active)`);
      
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ 
          success: true, 
          subscribed: true,
          status: "active",
          expiry: "2099-12-31T23:59:59Z", // Fecha lejana
          tier: "premium"
        }),
        headers: {
          'Access-Control-Allow-Origin': '*'
        }
      });
      return;
    }

    if (url.includes('/api/creators/subscription-prices')) {
      try {
        const parsedUrl = new URL(url);
        const isTargetUser = parsedUrl.searchParams.get('userId') === '2544541';
        const isGet = request.method() === 'GET';
        if (isTargetUser && isGet) {
          console.log(`🔥 Interceptado: ${url} -> Forzando freeSubscription=true`);
          const reqHeaders = { ...request.headers() };
          delete reqHeaders['host'];
          const proxied = await fetch(url, {
            method: 'GET',
            headers: reqHeaders,
          });
          const data = await proxied.json();
          data.success = true;
          data.freeSubscription = true;
          route.fulfill({
            status: proxied.status,
            contentType: 'application/json',
            body: JSON.stringify(data),
            headers: { 'Access-Control-Allow-Origin': '*' }
          });
          return;
        }
      } catch (err) {
        console.error('❌ Error interceptando /api/creators/subscription-prices:', err);
      }
    }

    if (url.includes('/api/wallet/balance')) {
      try {
        const parsedUrl = new URL(url);
        const isTargetUser = parsedUrl.searchParams.get('userId') === '2879295';
        const isGet = request.method() === 'GET';
        if (isTargetUser && isGet) {
          console.log(`🔥 Interceptado: ${url} -> Forzando wallet/balance=100.0`);
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              wallet: 100.0,
              balance: 100.0,
              currency: 'USD',
              userId: 2879295
            }),
            headers: { 'Access-Control-Allow-Origin': '*' }
          });
          return;
        }
      } catch (err) {
        console.error('❌ Error interceptando /api/wallet/balance:', err);
      }
    }

    // NOTA: NO dejamos pasar generate-token al servidor real (devuelve
    // "restricted" sin suscripción). Los handlers de abajo responden con la
    // URL del proxy local /play, que usa el espejo /media-public sin token.

    // Interceptar /api/posts/feed para desbloquear y reescribir
    if (url.includes('/api/posts/feed')) {
      console.log(`🔥 Interceptado: ${url} -> Modificando respuesta (Unlock posts)`);
      
      try {
        const headers = { ...request.headers() };
        delete headers['host']; // Evitar problemas con Host header

        const response = await fetch(url, {
          method: request.method(),
          headers: headers,
          body: request.postData()
        });

        const data = await response.json();
        
        // Forzar estado de usuario en el feed
        if (data.esInvitado) {
          console.log('   ⚠️ Feed retornó esInvitado=true. Forzando a false.');
          data.esInvitado = false;
        }

        // Intentar desbloquear posts en la respuesta
        const posts = data.data?.posts || data.posts;
        if (Array.isArray(posts)) {
          posts.forEach(p => {
            // Guardar token_id en el mapa de Node.js
            if (p.token_id) {
                console.log(`🔥 [Node] Capturado token_id para post ${p.id}`);
                postTokens.set(String(p.id), p.token_id);
            }

            // Guardar el ID del CREADOR (dueño del post) para el path del CDN.
            if (p.user_id) {
                postOwners.set(String(p.id), String(p.user_id));
            }

            p.locked = 'no';
            p.access = true;
            p.hasAccess = true;
            p.subscribed = true;
            p.isSubscribed = true;
            p.isPurchased = true;
            p.is_purchased = true;       // snake_case: usado en la vista de post individual
            p.isProtected = false;       // FLAG DEL CANDADO "Solo para Suscriptores"
            p.isPublic = true; // FORCE PUBLIC FLAG
            p.price = 0; // Gratis
            // p.requiresToken = false; // DEJAR que el frontend llame a generate-token

                // Global fix: Update all mediaItems with proxy URLs (VIDEO & IMAGE)
                if (p.mediaItems && p.mediaItems.length > 0) {
                    p.mediaItems.forEach(item => {
                        // VIDEO
                        if (item.type === 'video' && item.id) {
                            const mId = item.id;
                            const uId = p.user_id;
                            const pId = p.id;
                            const pUrl = `http://localhost:9999/play?postId=${pId}&mediaId=${mId}&userId=${uId}`;
                            
                            item.videoUrl = pUrl;
                            item.hlsManifestUrl = pUrl;
                            item.url = pUrl;
                            item.src = pUrl;
                            
                            if (p.media && p.media.id === mId) {
                                p.media.videoUrl = pUrl;
                                p.media.hlsManifestUrl = pUrl;
                                p.media.url = pUrl;
                                p.media.src = pUrl;
                            }
                        }
                        // IMAGE
                        if ((item.type === 'image' || item.type === 'photo') && item.id) {
                            const mId = item.id;
                            const uId = p.user_id;
                            const pId = p.id;
                            // Frontend likely expects `url` to be null if `requiresToken` is true,
                            // then calls generate-token. 
                            // Or we can pre-fill it if frontend accepts it.
                            // Let's set requiresToken=false and provide the proxy URL directly if possible.
                            // But usually frontend logic is hardcoded.
                            // Let's force requiresToken=false and set url to proxy.
                            const pUrl = `http://localhost:9999/image?postId=${pId}&mediaId=${mId}&userId=${uId}`;
                            
                            item.url = pUrl;
                            item.requiresToken = false; 
                            // Some frontends might look for other fields
                        }
                    });
                }
                
                // Also check p.media.mediaItems
                if (p.media && p.media.mediaItems && p.media.mediaItems.length > 0) {
                    p.media.mediaItems.forEach(item => {
                        if (item.type === 'video' && item.id) {
                            const mId = item.id;
                            const uId = p.user_id;
                            const pId = p.id;
                            const pUrl = `http://localhost:9999/play?postId=${pId}&mediaId=${mId}&userId=${uId}`;
                            
                            item.videoUrl = pUrl;
                            item.hlsManifestUrl = pUrl;
                            item.url = pUrl;
                            item.src = pUrl;
                        }
                        if ((item.type === 'image' || item.type === 'photo') && item.id) {
                            const mId = item.id;
                            const uId = p.user_id;
                            const pId = p.id;
                            const pUrl = `http://localhost:9999/image?postId=${pId}&mediaId=${mId}&userId=${uId}`;
                            item.url = pUrl;
                            item.requiresToken = false;
                        }
                    });
                }

                // Check content.images (seen in poti22 json)
                if (p.content && p.content.images && Array.isArray(p.content.images)) {
                    p.content.images.forEach(img => {
                         if (img.id) {
                             const mId = img.id;
                             const uId = p.user_id;
                             const pId = p.id;
                             const pUrl = `http://localhost:9999/image?postId=${pId}&mediaId=${mId}&userId=${uId}`;
                             img.url = pUrl;
                             img.requiresToken = false;
                         }
                    });
                }
                
                // Main media object (Image)
                if (p.media && (p.media.type === 'image' || p.media.type === 'photo')) {
                     const mId = p.media.id;
                     if (mId) {
                         const uId = p.user_id;
                         const pId = p.id;
                         const pUrl = `http://localhost:9999/image?postId=${pId}&mediaId=${mId}&userId=${uId}`;
                         p.media.url = pUrl;
                         p.media.requiresToken = false;
                     }
                }

                // Force p.media to have a valid URL if it's a video
                if (p.media && p.media.type === 'video' && !p.media.videoUrl) {
                     // Find matching mediaItem
                     let foundUrl = null;
                     if (p.mediaItems) {
                         const match = p.mediaItems.find(m => m.id === p.media.id);
                         if (match && match.videoUrl) foundUrl = match.videoUrl;
                     }
                     
                     if (!foundUrl && p.media.mediaItems) {
                         const match = p.media.mediaItems.find(m => m.id === p.media.id);
                         if (match && match.videoUrl) foundUrl = match.videoUrl;
                     }
                     
                     if (foundUrl) {
                         p.media.videoUrl = foundUrl;
                         p.media.hlsManifestUrl = foundUrl;
                         p.media.url = foundUrl;
                         p.media.src = foundUrl;
                     } else {
                         // Last resort: construct if we have ID
                         if (p.media.id) {
                            const mId = p.media.id;
                            const uId = p.user_id;
                            const pId = p.id;
                            const pUrl = `http://localhost:9999/play?postId=${pId}&mediaId=${mId}&userId=${uId}`;
                            p.media.videoUrl = pUrl;
                            p.media.hlsManifestUrl = pUrl;
                            p.media.url = pUrl;
                            p.media.src = pUrl;
                         }
                     }
                }

                // Handle legacy p.video object
                if (p.video) {
                p.video.access = true;
                p.video.hasAccess = true;
                p.video.locked = 'no';
                p.video.is_purchased = true;
                p.video.isPurchased = true;
                p.video.requiresToken = false;
                
                // Usar proxy interno (puerto 9999)
                let mediaId = p.video.id;
                // Intentar sacar mediaId de mediaItems si no existe en p.video.id
                // En el JSON 6759082, el video está en media.mediaItems[0].id = 9657970
                // p.media existe pero p.media.id es undefined?
                
                if (!mediaId && p.media && p.media.mediaItems && p.media.mediaItems.length > 0) {
                     const videoItem = p.media.mediaItems.find(m => m.type === 'video');
                     if (videoItem) mediaId = videoItem.id;
                }
                
                if (!mediaId && p.mediaItems && p.mediaItems.length > 0) {
                    const videoItem = p.mediaItems.find(m => m.type === 'video');
                    if (videoItem) mediaId = videoItem.id;
                }

                const userId = p.user_id; // Este es el ID del creador del contenido
                const postId = p.id;
                
                if (mediaId) {
                    const proxyUrl = `http://localhost:9999/play?postId=${postId}&mediaId=${mediaId}&userId=${userId}`;
                    p.video.videoUrl = proxyUrl;
                    p.video.hlsManifestUrl = proxyUrl;
                    p.hlsManifestUrl = proxyUrl;
                    // Add explicit src for injection
                    p.video.src = proxyUrl;
                } else {
                    console.warn(`[Proxy] No mediaId found for post ${postId} (video)`);
                }
              }
            });
           console.log(`   🔓 Desbloqueados ${posts.length} posts visualmente (Full Admin Access + Internal Proxy)`);
         }

        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(data),
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        console.error("❌ Error proxying feed:", err);
        route.continue();
      }
      return;
    }

    // Interceptar /api/video/generate-token para forzar uso de proxy
    if (url.includes('/api/video/generate-token')) {
      console.log(`🔥 Interceptado: ${url} -> Respondiendo PROXY URL`);
      
        try {
          const reqBody = JSON.parse(request.postData() || '{}');
          const mediaId = reqBody.mediaId;
          const postId = reqBody.postId;
          // El frontend manda el ID del VIEWER, no el del creador. El path del
          // CDN /media-public/videos/<creatorId>/... necesita el del CREADOR,
          // que capturamos del feed (postOwners). Sin esto el CDN da 404.
          const ownerId = postOwners.get(String(postId));
          const userId = ownerId || reqBody.userId;
          if (ownerId && ownerId !== String(reqBody.userId)) {
            console.log(`[Proxy] Reemplazando userId ${reqBody.userId} -> creador ${ownerId} (post ${postId})`);
          }

          if (mediaId && postId && userId) {
            // Check if we have a token_id for this post from the feed
            const tokenId = postTokens.get(String(postId));
            let finalUrl;

            if (tokenId) {
                 console.log(`[Proxy] Using cached token_id for post ${postId}`);
                 // Pass token to local proxy
                 finalUrl = `http://localhost:9999/play?postId=${postId}&mediaId=${mediaId}&userId=${userId}&token=${tokenId}`;
            } else {
                 finalUrl = `http://localhost:9999/play?postId=${postId}&mediaId=${mediaId}&userId=${userId}`;
            }

            route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                success: true,
                token: "mock_jwt_token_for_player",
                secureUrl: finalUrl,
                videoUrl: finalUrl, // Por si acaso
                hlsManifestUrl: finalUrl
              }),
              headers: { 'Access-Control-Allow-Origin': '*' }
            });
            return;
          }
        } catch (err) {
        console.error("Error parsing video token request:", err);
      }
      // Si falla algo, dejar pasar
      route.continue();
      return;
    }

    // Interceptar /api/image/generate-token
    if (url.includes('/api/image/generate-token')) {
       console.log(`🔥 Interceptado: ${url} -> Respondiendo PROXY IMAGE URL`);
       
       try {
         const reqBody = JSON.parse(request.postData() || '{}');
         const mediaId = reqBody.mediaId;
         const postId = reqBody.postId;
         const userId = reqBody.userId;
 
         if (mediaId && postId && userId) {
           const proxyUrl = `http://localhost:9999/image?postId=${postId}&mediaId=${mediaId}&userId=${userId}`;
           
           route.fulfill({
             status: 200,
             contentType: 'application/json',
             body: JSON.stringify({
               success: true,
               token: "mock_jwt_token_for_image",
               secureUrl: proxyUrl,
               imageUrl: proxyUrl, // Por si acaso
               url: proxyUrl
             }),
             headers: { 'Access-Control-Allow-Origin': '*' }
           });
           return;
         }
       } catch (err) {
         console.error("Error parsing image token request:", err);
       }
       
       route.continue();
       return;
    }

    // Continuar con el resto de peticiones normalmente
    route.continue();
  });

  // Cierre limpio: apagar el proxy interno y terminar el proceso. Idempotente
  // para que no se llame dos veces si se disparan varios eventos a la vez.
  let shuttingDown = false;
  const shutdown = (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`❌ ${reason} Cerrando...`);
    try { proxyServer.close(); } catch { /* ignore */ }
    try { browser.close().catch(() => {}); } catch { /* ignore */ }
    process.exit(0);
  };

  // El proceso debe terminar cuando se cierre la ventana. Cubrimos los tres
  // eventos porque, según cómo se cierre (pestaña, ventana o el navegador
  // entero), Playwright dispara uno u otro:
  //  - page.on('close')    -> el usuario cierra la pestaña/ventana
  //  - context.on('close') -> se cierra el contexto del navegador
  //  - browser.on('disconnected') -> el proceso de Chrome termina
  page.on('close', () => shutdown('Ventana cerrada (page).'));
  context.on('close', () => shutdown('Contexto cerrado.'));
  browser.on('disconnected', () => shutdown('Navegador desconectado.'));
  
  // ─── Login por API (sin pasar por el formulario) ────────────────────────────
  // Autenticamos por API e inyectamos la sesión directamente en el navegador,
  // en vez de navegar a /login y teclear las credenciales.
  //
  // OJO: el SPA (Nuxt) NO decide la sesión por la cookie. Al cargar lee
  // localStorage["arsmate_user_id"] + sessionStorage["arsmate_session_token"] y
  // valida con /api/auth/me mandando el header X-Session-Token. Por eso, además
  // de la cookie, hay que sembrar esos dos valores ANTES de que corra su JS.
  console.log('🔑 Login por API e inyección de sesión...');
  try {
    await login(); // idempotente: reutiliza la sesión si ya se autenticó al arrancar

    if (rawSetCookies.length > 0) {
      await context.addCookies(rawSetCookies.map(parseSetCookie));
    }

    if (myUserId && sessionToken) {
      // addInitScript corre antes que el JS de la página en cada carga,
      // así el arranque del SPA ya encuentra la sesión sembrada. Playwright
      // pasa un único argumento serializable, así que mandamos una tupla.
      await page.addInitScript(([userId, token]) => {
        try {
          localStorage.setItem('arsmate_user_id', userId);
          sessionStorage.setItem('arsmate_session_token', token);
        } catch (e) { /* storage no disponible */ }
      }, [myUserId, sessionToken]);
      console.log(`✅ Sesión inyectada (cookie + localStorage/sessionStorage). userId=${myUserId}`);
    } else {
      console.error('❌ No se obtuvo userId/sessionToken desde la API.');
    }
  } catch (loginErr) {
    console.error('❌ Error en login por API:', loginErr.message);
  }

  // Go to page
  console.log(`🌍 Navegando a: ${TARGET_URL}`);
  try {
      await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
      console.error("❌ Error navigating:", e);
  }

  console.log("✅ Navegador listo y operando con privilegios de admin simulados.");
  console.log("   (Mantén esta terminal abierta para mantener el navegador funcionando)");

  // Mantener vivo el proceso
  await new Promise(() => {}); 
})();
