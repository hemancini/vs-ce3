#!/usr/bin/env node
/**
 * candies/admin-browser.mjs
 * Abre un navegador (Chrome) sobre candies.me, intercepta el feed del backend de
 * Candies y reinyecta las cabeceras de los medios para poder reproducirlos.
 *
 * A diferencia de arsmate, Candies NO usa tokens por-post: los archivos vienen
 * con URLs firmadas (token con expiración) que el backend sólo entrega a una
 * petición con `Referer`/`Origin` de https://candies.me. Un <video src> del
 * navegador nunca manda ese Referer, así que el medio pasa por un proxy local
 * que reinyecta las cabeceras correctas (mismo criterio que
 * src/pages/api/candies/proxy.ts) y reenvía el `Range` para el seek.
 *
 * Login: Candies usa Firebase Auth. El script hace signInWithPassword por API,
 * siembra la sesión en IndexedDB para que el SPA arranque logueado e inyecta el
 * Bearer en las llamadas al backend. El contenido bloqueado sólo se desbloquea
 * si la cuenta está suscrita al creador (el backend no firma la `url` si no).
 *
 * Credenciales: por env (CANDIES_EMAIL / CANDIES_PASSWORD) o CLI
 * (--email / --password). Sin ellas, el login queda manual en la ventana.
 *
 * Uso:
 *   CANDIES_EMAIL=tu@mail CANDIES_PASSWORD=secreta node scripts/candies/admin-browser.mjs
 *   node scripts/candies/admin-browser.mjs --email tu@mail --password secreta https://candies.me/creador/1813
 *   node scripts/candies/admin-browser.mjs --id 1813   # además vuelca el feed público a output/
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, URL } from 'node:url';

// ─── Constantes de Candies ──────────────────────────────────────────────────
const CANDIES_BASE = 'https://candies.me';
const CANDIES_ORIGIN = 'https://candies.me';
const CANDIES_BACKEND =
  'https://candies-backend-82243139240.southamerica-west1.run.app';

// Candies usa Firebase Authentication (proyecto "candiess"). El login NO es un
// endpoint propio: el SPA hace signInWithPassword contra Firebase, guarda la
// sesión en IndexedDB (firebaseLocalStorageDb) y manda el idToken como
// `Authorization: Bearer` al backend. Por eso aquí: (1) hacemos el login por la
// API de Firebase, (2) sembramos esa sesión en IndexedDB para que el SPA arranque
// logueado, y (3) inyectamos el Bearer en las llamadas al backend como red de
// seguridad. La apiKey es pública (va en el bundle del front).
const FIREBASE_API_KEY = 'AIzaSyD_piaQ6fV4HnYz69ZsccOPYTYrZYmMqO8';

// Credenciales: por env (CANDIES_EMAIL / CANDIES_PASSWORD) o CLI
// (--email x --password y). Sin ellas, el login queda manual en la ventana.
function readCred(flag, envName) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[envName] || '';
}
const CANDIES_EMAIL = readCred('--email', 'CANDIES_EMAIL');
const CANDIES_PASSWORD = readCred('--password', 'CANDIES_PASSWORD');

// Sesión de Firebase capturada tras el login (rellenada por firebaseLogin()).
let fbSession = null; // { idToken, refreshToken, localId, email, expiresInSec }

// Hace signInWithPassword contra Firebase y guarda la sesión en fbSession.
async function firebaseLogin() {
  if (!CANDIES_EMAIL || !CANDIES_PASSWORD) {
    console.warn('⚠️  Sin CANDIES_EMAIL/CANDIES_PASSWORD: login manual en la ventana.');
    return null;
  }
  console.log(`🔑 Login en Firebase (candiess) para: ${CANDIES_EMAIL}`);
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Referer: `${CANDIES_ORIGIN}/`,
          Origin: CANDIES_ORIGIN,
        },
        body: JSON.stringify({
          email: CANDIES_EMAIL,
          password: CANDIES_PASSWORD,
          returnSecureToken: true,
        }),
      },
    );
    const data = await res.json();
    if (!res.ok) {
      console.error(`❌ Login Firebase falló (${res.status}):`, data?.error?.message || data);
      return null;
    }
    fbSession = {
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      localId: data.localId,
      email: data.email,
      expiresInSec: parseInt(data.expiresIn || '3600', 10),
    };
    console.log(`✅ Login Firebase OK. uid=${fbSession.localId}`);
    return fbSession;
  } catch (err) {
    console.error('❌ Error en login Firebase:', err.message);
    return null;
  }
}

// Hosts cuyos medios proxyamos (mismo allowlist que el proxy de producción) para
// no convertir esto en un proxy abierto hacia cualquier dominio.
const ALLOWED_MEDIA_HOSTS = [
  'media.candies.me',
  'candies-backend-82243139240.southamerica-west1.run.app',
  'r2.cloudflarestorage.com', // thumbnails / gifs firmados (R2)
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'output');

function isAllowedMedia(target) {
  try {
    const host = new URL(target).hostname;
    return ALLOWED_MEDIA_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

// ─── Proxy interno (medios + HLS) ────────────────────────────────────────────
// Reinyecta Referer/Origin de candies.me y reenvía Range. Para HLS reescribe el
// manifest para que segmentos/keys vuelvan a pasar por aquí (CORS + Referer).
const INTERNAL_PROXY_PORT = 9788; // distinto del de arsmate (9999) por si corren a la vez

function buildUpstreamHeaders(reqHeaders) {
  const headers = {
    'User-Agent':
      reqHeaders['user-agent'] ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: `${CANDIES_ORIGIN}/`,
    Origin: CANDIES_ORIGIN,
  };
  for (const h of ['accept', 'accept-language', 'range', 'if-none-match', 'if-modified-since', 'cache-control']) {
    if (reqHeaders[h]) headers[h.replace(/(^|-)([a-z])/g, (m) => m.toUpperCase())] = reqHeaders[h];
  }
  if (reqHeaders['range']) headers['Range'] = reqHeaders['range'];
  return headers;
}

const proxyServer = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${INTERNAL_PROXY_PORT}`);

  // ─── Route: /media (binario directo: mp4, jpg, gif firmados) ───────────────
  // ─── Route: /manifest (HLS .m3u8 reescrito + segmentos .ts/.key) ───────────
  if (u.pathname === '/media' || u.pathname === '/manifest') {
    const target = u.searchParams.get('url');
    if (!target) { res.writeHead(400); res.end('Missing url param'); return; }
    if (!isAllowedMedia(target)) { res.writeHead(403); res.end('Host not allowed'); return; }

    try {
      const upstream = await fetch(target, { headers: buildUpstreamHeaders(req.headers), redirect: 'follow' });
      const contentType = upstream.headers.get('content-type') || '';
      const isManifest =
        u.pathname === '/manifest' &&
        (contentType.includes('mpegurl') || target.includes('.m3u8'));

      const headers = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-expose-headers': 'content-length, content-range, accept-ranges',
      };
      if (upstream.headers.has('content-type')) headers['content-type'] = upstream.headers.get('content-type');

      if (isManifest) {
        // El manifest reescrito cambia de tamaño: NO reenviar content-length.
        const text = await upstream.text();
        const basePath = target.substring(0, target.lastIndexOf('/') + 1);
        const rewriteAbs = (rel) => {
          const absUrl = rel.startsWith('http') ? rel : new URL(rel, basePath).href;
          return `http://localhost:${INTERNAL_PROXY_PORT}/manifest?url=${encodeURIComponent(absUrl)}`;
        };
        const rewritten = text
          .replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${rewriteAbs(uri)}"`)
          .replace(/^(?!#)(.+)$/gm, (match) => rewriteAbs(match.trim()));
        res.writeHead(upstream.status, headers);
        res.end(rewritten);
      } else {
        // Stream binario — preservar Range/206.
        for (const h of ['content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) {
          if (upstream.headers.has(h)) headers[h] = upstream.headers.get(h);
        }
        res.writeHead(upstream.status, headers); // 206 si vino Range
        const arrayBuffer = await upstream.arrayBuffer();
        res.end(Buffer.from(arrayBuffer));
      }
    } catch (err) {
      console.error('Proxy media error:', err.message);
      res.writeHead(502); res.end('Upstream unreachable');
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

proxyServer.listen(INTERNAL_PROXY_PORT, () => {
  console.log(`🎧 Proxy interno escuchando en http://localhost:${INTERNAL_PROXY_PORT}`);
});

// Devuelve la URL local del proxy para un recurso de Candies (o la original si
// no es un host conocido / no es proxyable).
function proxify(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  if (!isAllowedMedia(rawUrl)) return rawUrl;
  const route = /\.m3u8(\?|$)/.test(rawUrl) ? 'manifest' : 'media';
  return `http://localhost:${INTERNAL_PROXY_PORT}/${route}?url=${encodeURIComponent(rawUrl)}`;
}

// ─── Volcado del feed público a output/ (opcional, --id) ─────────────────────
// Mirror de scripts/arsmate/output: guarda el JSON crudo por creador para poder
// versionarlo luego en src/data (como hace el namespace /ars).
async function dumpPublicFeed(creatorId) {
  try {
    const res = await fetch(`${CANDIES_BACKEND}/pub/creador/${creatorId}`, {
      headers: {
        Referer: `${CANDIES_ORIGIN}/`,
        Origin: CANDIES_ORIGIN,
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
    });
    if (!res.ok) {
      console.error(`❌ Feed público ${creatorId}: HTTP ${res.status}`);
      return;
    }
    const data = await res.json();
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(OUTPUT_DIR, `candies-creador-${creatorId}-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    const posts = Array.isArray(data?.datos) ? data.datos : [];
    console.log(`💾 Feed público guardado: ${path.relative(process.cwd(), file)} (${posts.length} posts)`);
  } catch (err) {
    console.error('❌ Error volcando feed público:', err.message);
  }
}

// ─── Localizar Chrome ────────────────────────────────────────────────────────
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
const executablePath = CHROME_PATHS.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error('❌ No se encontró Google Chrome instalado en las rutas estándar.');
  console.error('Por favor, instala Google Chrome o ajusta CHROME_PATHS en el script.');
  process.exit(1);
}

// ─── Args ────────────────────────────────────────────────────────────────────
const TARGET_URL = process.argv.find((a) => a.startsWith('http')) || CANDIES_BASE;
const idArgIdx = process.argv.findIndex((a) => a === '--id');
const dumpId =
  idArgIdx !== -1 ? (process.argv[idArgIdx + 1] || '').replace(/[^0-9]/g, '') : null;

// ─── ¿Es una respuesta de feed del backend de Candies? ───────────────────────
// El SPA pide el feed al backend (run.app). Cubrimos el público (/pub/creador/)
// y cualquier variante autenticada que contenga /creador/.
function isCandiesFeedUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const isBackend = hostname.endsWith('run.app') || hostname === 'media.candies.me';
    return isBackend && /\/creador\/\d+/.test(pathname);
  } catch {
    return false;
  }
}

// Reescribe en su sitio las URLs de medios de un post para que pasen por el proxy
// local. Devuelve true si el post quedó (al menos parcialmente) reproducible.
function rewritePostMedia(post) {
  let playable = false;
  const archivos = Array.isArray(post?.archivos) ? post.archivos : [];
  for (const a of archivos) {
    if (a.url) { a.url = proxify(a.url); playable = true; }
    if (a.urlHls) { a.urlHls = proxify(a.urlHls); playable = true; }
    if (a.thumbnailUrl) a.thumbnailUrl = proxify(a.thumbnailUrl);
    if (a.gifUrl) a.gifUrl = proxify(a.gifUrl);
    if (a.thumbnailBlurUrl) a.thumbnailBlurUrl = proxify(a.thumbnailBlurUrl);
    if (a.gifBlurUrl) a.gifBlurUrl = proxify(a.gifBlurUrl);
  }
  // Si el archivo trae una url firmada real, ya no está bloqueado de hecho.
  if (playable) post.bloqueada = false;
  return playable;
}

(async () => {
  console.log(`🚀 Lanzando Chrome desde: ${executablePath}`);

  const browser = await chromium.launch({
    executablePath,
    headless: false,
    args: [
      '--start-maximized',
      '--auto-open-devtools-for-tabs',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--remote-debugging-port=9223', // distinto del de arsmate (9222)
      '--allow-running-insecure-content',
      '--ignore-certificate-errors',
      '--allow-insecure-localhost',
    ],
  });

  const context = await browser.newContext({
    viewport: null,
    bypassCSP: true,        // permite cargar http://localhost:9788/... pese a la CSP de candies.me
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  // Desactivar el caché HTTP: si no, al navegar dentro del SPA Chrome serviría el
  // feed desde caché sin pasar por nuestro interceptor.
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.setCacheDisabled', { cacheDisabled: true });

  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('🔥') || text.includes('[Injector]')) console.log(`[PAGE] ${text}`);
  });

  // ─── Log de toda la red a un .jsonl (para analizar la API de Candies) ──────
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const logStream = fs.createWriteStream(path.join(OUTPUT_DIR, 'network_full.jsonl'), { flags: 'w' });
  page.on('response', async (response) => {
    const url = response.url();
    if (url.startsWith('data:')) return;
    try {
      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      let body = '[Binary/Large]';
      if (contentType.includes('application/json') || contentType.includes('text/') || contentType.includes('xml')) {
        try { body = await response.text(); } catch { body = '[Error reading body]'; }
      }
      logStream.write(
        JSON.stringify({
          url,
          method: response.request().method(),
          status: response.status(),
          headers,
          body: body.length > 5000 ? body.substring(0, 5000) + '...' : body,
        }) + '\n',
      );
    } catch { /* ignore */ }
  });

  // ─── Interceptor del feed: reescribe medios -> proxy local ─────────────────
  await page.route('**/*', async (route, request) => {
    const url = request.url();

    // ─── Auth: forzar rol ADMIN ──────────────────────────────────────────────
    // El SPA pide su perfil a /autenticacion/sincronizar (y /perfil) y la
    // respuesta trae `datos.rol` ("CONSUMIDOR"). Reescribimos a "ADMIN" para que
    // el frontend habilite las vistas/acciones de administrador.
    if (/\/autenticacion\/(sincronizar|perfil)/.test(url)) {
      console.log(`🔥 Interceptado auth: ${url} -> rol=ADMIN`);
      try {
        const reqHeaders = { ...request.headers() };
        delete reqHeaders['host'];
        if (fbSession?.idToken && !reqHeaders['authorization']) {
          reqHeaders['authorization'] = `Bearer ${fbSession.idToken}`;
        }
        const upstream = await fetch(url, {
          method: request.method(),
          headers: reqHeaders,
          body: request.postData() || undefined,
        });
        const data = await upstream.json();
        // La forma es { datos: { ...rol } }; cubrimos también un objeto plano.
        const target = data?.datos && typeof data.datos === 'object' ? data.datos : data;
        if (target && typeof target === 'object') {
          target.rol = 'ADMIN';
          target.isAdmin = true;
          target.esAdmin = true;
        }
        route.fulfill({
          status: upstream.status,
          contentType: 'application/json',
          body: JSON.stringify(data),
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      } catch (err) {
        console.error('❌ Error interceptando auth:', err.message);
        route.continue();
      }
      return;
    }

    if (isCandiesFeedUrl(url)) {
      console.log(`🔥 Interceptado feed: ${url}`);
      try {
        // Re-pedimos con las MISMAS cabeceras del navegador (incluye el
        // Authorization/Bearer si el usuario inició sesión), así conservamos
        // el estado de suscripción.
        const reqHeaders = { ...request.headers() };
        delete reqHeaders['host'];
        // Red de seguridad: si la petición no trae Authorization pero tenemos
        // sesión de Firebase, inyectamos el Bearer para que el backend devuelva
        // el contenido de suscriptor.
        if (fbSession?.idToken && !reqHeaders['authorization']) {
          reqHeaders['authorization'] = `Bearer ${fbSession.idToken}`;
        }

        const upstream = await fetch(url, {
          method: request.method(),
          headers: reqHeaders,
          body: request.postData() || undefined,
        });

        const data = await upstream.json();
        const posts = Array.isArray(data?.datos) ? data.datos : Array.isArray(data) ? data : [];
        let unlocked = 0;
        for (const post of posts) if (rewritePostMedia(post)) unlocked++;
        console.log(`   ↳ ${posts.length} posts, ${unlocked} con medio reproducible (proxy)`);

        route.fulfill({
          status: upstream.status,
          contentType: 'application/json',
          body: JSON.stringify(data),
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      } catch (err) {
        console.error('❌ Error interceptando feed:', err.message);
        route.continue();
      }
      return;
    }

    route.continue();
  });

  // ─── Cierre limpio ─────────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`❌ ${reason} Cerrando...`);
    try { logStream.end(); } catch { /* ignore */ }
    try { proxyServer.close(); } catch { /* ignore */ }
    try { browser.close().catch(() => { }); } catch { /* ignore */ }
    process.exit(0);
  };
  page.on('close', () => shutdown('Ventana cerrada (page).'));
  context.on('close', () => shutdown('Contexto cerrado.'));
  browser.on('disconnected', () => shutdown('Navegador desconectado.'));

  // Volcado opcional del feed público (no requiere sesión).
  if (dumpId) await dumpPublicFeed(dumpId);

  // ─── Login: Firebase API + siembra de sesión en IndexedDB ──────────────────
  // Primero hacemos el login por API; luego abrimos candies.me (necesario para
  // que exista el origen donde vive IndexedDB), sembramos la sesión de Firebase
  // y recargamos para que el SPA arranque ya logueado.
  await firebaseLogin();

  console.log(`🌍 Abriendo: ${CANDIES_BASE}`);
  try {
    await page.goto(CANDIES_BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.error('❌ Error abriendo candies.me:', e.message);
  }

  if (fbSession?.idToken) {
    try {
      // Construimos el registro que Firebase Web SDK espera en IndexedDB
      // (db firebaseLocalStorageDb / store firebaseLocalStorage, keyPath fbase_key).
      const fbKey = `firebase:authUser:${FIREBASE_API_KEY}:[DEFAULT]`;
      const nowMs = Date.now();
      const userRecord = {
        uid: fbSession.localId,
        email: fbSession.email,
        emailVerified: true,
        isAnonymous: false,
        providerData: [
          {
            providerId: 'password',
            uid: fbSession.email,
            displayName: null,
            email: fbSession.email,
            phoneNumber: null,
            photoURL: null,
          },
        ],
        stsTokenManager: {
          refreshToken: fbSession.refreshToken,
          accessToken: fbSession.idToken,
          expirationTime: nowMs + fbSession.expiresInSec * 1000,
        },
        createdAt: String(nowMs),
        lastLoginAt: String(nowMs),
        apiKey: FIREBASE_API_KEY,
        appName: '[DEFAULT]',
      };

      await page.evaluate(
        ([key, value]) =>
          new Promise((resolve, reject) => {
            const open = indexedDB.open('firebaseLocalStorageDb');
            open.onupgradeneeded = () => {
              const db = open.result;
              if (!db.objectStoreNames.contains('firebaseLocalStorage')) {
                db.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
              }
            };
            open.onsuccess = () => {
              const db = open.result;
              // Si el store no existe (DB recién creada sin upgrade), recrear con versión+1.
              if (!db.objectStoreNames.contains('firebaseLocalStorage')) {
                const v = db.version + 1;
                db.close();
                const up = indexedDB.open('firebaseLocalStorageDb', v);
                up.onupgradeneeded = () =>
                  up.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
                up.onsuccess = () => {
                  const tx = up.result.transaction('firebaseLocalStorage', 'readwrite');
                  tx.objectStore('firebaseLocalStorage').put({ fbase_key: key, value });
                  tx.oncomplete = () => resolve(true);
                  tx.onerror = () => reject(tx.error);
                };
                up.onerror = () => reject(up.error);
                return;
              }
              const tx = db.transaction('firebaseLocalStorage', 'readwrite');
              tx.objectStore('firebaseLocalStorage').put({ fbase_key: key, value });
              tx.oncomplete = () => resolve(true);
              tx.onerror = () => reject(tx.error);
            };
            open.onerror = () => reject(open.error);
          }),
        [fbKey, userRecord],
      );
      console.log('✅ Sesión de Firebase sembrada en IndexedDB. Recargando...');
      await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
    } catch (e) {
      console.error('❌ Error sembrando sesión en IndexedDB:', e.message);
    }
  }

  // Navegar al destino final (creador) si es distinto del home.
  if (TARGET_URL !== CANDIES_BASE) {
    console.log(`🌍 Navegando a: ${TARGET_URL}`);
    try {
      await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });
    } catch (e) {
      console.error('❌ Error navigating:', e.message);
    }
  }

  console.log('✅ Navegador listo.');
  if (!fbSession) {
    console.log('   (Sin credenciales) Inicia sesión manualmente en la ventana;');
    console.log('   el feed y los medios se reescriben igual a través del proxy local.');
  }
  console.log('   (Mantén esta terminal abierta para mantener el navegador vivo)');

  await new Promise(() => { }); // keep-alive
})();
