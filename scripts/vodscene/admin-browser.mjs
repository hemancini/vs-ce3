#!/usr/bin/env node
/**
 * vodscene/admin-browser.mjs
 * Abre un navegador (Chrome) sobre vodscene.com, siembra la sesión de Firebase
 * para que el SPA arranque logueado, registra la sesión de dispositivo y modifica
 * las respuestas de Firestore/auth para forzar rol ADMIN y desbloquear el catálogo.
 *
 * A diferencia de arsmate/candies, vodscene NO tiene un backend JSON propio: el
 * SPA lee los videos DIRECTAMENTE de Firestore con el Firebase JS SDK. El gating
 * (suscripción / admin / video activo) vive en documentos tipados de Firestore
 * (`users/{uid}`, `videos/{id}`). Por eso el interceptor de aquí reescribe las
 * respuestas REST de Firestore (`:runQuery` / `:batchGet` / documents GET) sobre
 * los VALORES TIPADOS ({stringValue}, {booleanValue}, ...).
 *
 * OJO (DRM): los videos usan Widevine/EZDRM. El navegador reproduce el DRM de
 * forma nativa (CDM), así que NO hace falta proxyar los medios como en
 * arsmate/candies: el CDN de vodscene sirve los manifiestos sin gating de
 * Referer (ver download-video.mjs, que baja los .mpd con un fetch pelado). Lo que
 * sí hace falta es (1) sesión válida sembrada, (2) registerUserSession para que
 * el enforcement de "sesión única" no expulse, y (3) desbloqueo del gating.
 *
 * OJO (Listen en tiempo real): si el SPA usa el canal WebChannel
 * (`Firestore/Listen/channel`) para snapshots en vivo, ese stream NO es
 * interceptable de forma fiable con page.route. Los desbloqueos de este script
 * cubren las lecturas REST (`:runQuery`, `:batchGet`, GET de documento). Revisa
 * output/network_full.jsonl para ver qué endpoints usa realmente tu build y
 * ajusta las listas de campos de abajo.
 *
 * Credenciales: por env (VODSCENE_EMAIL / VODSCENE_PASSWORD) o CLI
 * (--email / --password). Sin ellas, cae a las de firestore-dump.js.
 *
 * Uso:
 *   node scripts/vodscene/admin-browser.mjs
 *   VODSCENE_EMAIL=tu@mail VODSCENE_PASSWORD=secreta node scripts/vodscene/admin-browser.mjs
 *   node scripts/vodscene/admin-browser.mjs --email tu@mail --password secreta https://vodscene.com/mi-pagina
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

// ─── Constantes de vodscene / Firebase ───────────────────────────────────────
const VODSCENE_BASE = 'https://vodscene.com';
const VODSCENE_ORIGIN = 'https://vodscene.com';

// Firebase (proyecto "payperview-7c21f"). La apiKey es pública (va en el bundle).
const FIREBASE_API_KEY = 'AIzaSyAUPv7dU2kEk1rdC__6z8aGlPYPfQh_ogA';
const FIREBASE_PROJECT = 'payperview-7c21f';

// Cloud Function que registra la sesión del dispositivo. vodscene aplica
// "sesión única": sin registrar, puede expulsar o bloquear la reproducción.
const CF_REGION = 'us-central1';
const CF_REGISTER_SESSION_URL = `https://${CF_REGION}-${FIREBASE_PROJECT}.cloudfunctions.net/registerUserSession`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'output');

// ─── Credenciales ────────────────────────────────────────────────────────────
// por env (VODSCENE_EMAIL / VODSCENE_PASSWORD) o CLI (--email x --password y).
// Fallback: las de firestore-dump.js / download-video.mjs.
function readCred(flag, envName, fallback) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[envName] || fallback;
}
const VODSCENE_EMAIL = readCred('--email', 'VODSCENE_EMAIL', 'm45942076@gmail.com');
const VODSCENE_PASSWORD = readCred('--password', 'VODSCENE_PASSWORD', 'minasricas00');

// Sesión de Firebase capturada tras el login.
let fbSession = null; // { idToken, refreshToken, localId, email, expiresInSec }

// ─── Login en Firebase ───────────────────────────────────────────────────────
async function firebaseLogin() {
  if (!VODSCENE_EMAIL || !VODSCENE_PASSWORD) {
    console.warn('⚠️  Sin VODSCENE_EMAIL/VODSCENE_PASSWORD: login manual en la ventana.');
    return null;
  }
  console.log(`🔑 Login en Firebase (${FIREBASE_PROJECT}) para: ${VODSCENE_EMAIL}`);
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Referer: `${VODSCENE_ORIGIN}/`,
          Origin: VODSCENE_ORIGIN,
        },
        body: JSON.stringify({
          email: VODSCENE_EMAIL,
          password: VODSCENE_PASSWORD,
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

// ─── Registrar sesión del dispositivo (Cloud Function) ───────────────────────
// vodscene aplica sesión única. Sin registrar, el enforcement puede cortar la
// reproducción. Devuelve el payload de sesión (útil para inspeccionar y, si hay
// que sembrarlo, ver qué claves usa el front).
let sessionData = null;
async function registerUserSession() {
  if (!fbSession?.idToken) return null;
  console.log('🪪 Registrando sesión (registerUserSession)...');
  try {
    const res = await fetch(CF_REGISTER_SESSION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${fbSession.idToken}`,
        Referer: `${VODSCENE_ORIGIN}/`,
        Origin: VODSCENE_ORIGIN,
      },
      body: JSON.stringify({ uid: fbSession.localId, userAgent: 'Mozilla/5.0', platform: 'web' }),
    });
    let data = {};
    try { data = await res.json(); } catch { /* sin JSON */ }
    if (!res.ok) {
      console.warn(`⚠️  registerUserSession: ${res.status} — continuo con el idToken igualmente.`);
    } else {
      sessionData = data;
      console.log(`✅ Sesión registrada. keys: ${Object.keys(data).join(', ') || '(vacío)'}`);
    }
    return data;
  } catch (err) {
    console.warn('⚠️  Error en registerUserSession:', err.message);
    return null;
  }
}

// ─── ¿Es una lectura REST de Firestore de este proyecto? ─────────────────────
// Cubrimos las lecturas REST: `:runQuery`, `:batchGet`, `:listDocuments` y GET de
// documento bajo /v1/projects/<proyecto>/databases/.../documents...
// NO cubre el canal en vivo (Firestore/Listen/channel), que es WebChannel.
function isFirestoreRestUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname !== 'firestore.googleapis.com') return false;
    return pathname.includes(`/projects/${FIREBASE_PROJECT}/databases/`);
  } catch {
    return false;
  }
}

// ─── Forzado de campos sobre VALORES TIPADOS de Firestore ────────────────────
// Un documento de Firestore REST trae `fields: { campo: { stringValue|booleanValue|... } }`.
// Estos helpers imponen valores tipados sin decodificar todo el árbol.

// Campos de perfil de usuario que habilitan admin / suscripción.
// (Ajusta según lo que veas en users/{uid} en output/network_full.jsonl.)
const USER_TRUE_FLAGS = [
  'isAdmin', 'admin', 'esAdmin',
  'isSubscribed', 'subscribed', 'suscrito', 'hasSubscription',
  'isPremium', 'premium', 'isVip', 'vip',
  'isActive', 'active', 'verified', 'emailVerified',
];
const USER_STRING_OVERRIDES = {
  role: 'admin', rol: 'admin', plan: 'premium', tier: 'premium',
  subscriptionStatus: 'active', membership: 'premium',
};

// Campos de video que lo dejan reproducible y sin gating de compra/suscripción.
const VIDEO_TRUE_FLAGS = [
  'isActive', 'active', 'published', 'isPublic', 'hasAccess', 'access',
  'isPurchased', 'purchased', 'unlocked', 'permitirPlaySinDRM',
];
const VIDEO_FALSE_FLAGS = [
  'requiresSubscription', 'requiresPurchase', 'isPremium', 'isLocked',
  'locked', 'requiereSuscripcion', 'requierePago', 'bloqueado',
];
const VIDEO_STRING_OVERRIDES = {
  processingStatus: 'ready',
};

function setBool(fields, key, value) {
  // Sólo tocamos claves ya presentes (evita inventar campos que rompan el front).
  if (fields[key] !== undefined) fields[key] = { booleanValue: value };
}
function setString(fields, key, value) {
  if (fields[key] !== undefined) fields[key] = { stringValue: value };
}

// Muta en su sitio los `fields` de un documento según su colección (path/name).
function forceDocFields(name, fields) {
  if (!fields || typeof fields !== 'object') return;
  const isUser = /\/users\//.test(name || '');
  const isVideo = /\/videos\//.test(name || '');

  if (isUser) {
    for (const k of USER_TRUE_FLAGS) setBool(fields, k, true);
    for (const [k, v] of Object.entries(USER_STRING_OVERRIDES)) setString(fields, k, v);
  }
  if (isVideo) {
    for (const k of VIDEO_TRUE_FLAGS) setBool(fields, k, true);
    for (const k of VIDEO_FALSE_FLAGS) setBool(fields, k, false);
    for (const [k, v] of Object.entries(VIDEO_STRING_OVERRIDES)) setString(fields, k, v);
  }
}

// Recorre una respuesta REST de Firestore (varias formas) y muta sus documentos.
// Devuelve el nº de documentos tocados.
function rewriteFirestoreResponse(data) {
  let touched = 0;
  const handleDoc = (doc) => {
    if (doc && doc.name && doc.fields) { forceDocFields(doc.name, doc.fields); touched++; }
  };

  // :runQuery -> [{ document }, { document }, ...]
  if (Array.isArray(data)) {
    for (const chunk of data) if (chunk?.document) handleDoc(chunk.document);
    return touched;
  }
  // :batchGet -> { found: { document } } por línea, o GET simple -> { name, fields }
  if (data?.found?.document) handleDoc(data.found.document);
  if (data?.name && data?.fields) handleDoc(data);
  // :listDocuments -> { documents: [ { name, fields } ] }
  if (Array.isArray(data?.documents)) for (const d of data.documents) handleDoc(d);
  return touched;
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
const TARGET_URL = process.argv.find((a) => a.startsWith('http')) || VODSCENE_BASE;

(async () => {
  console.log(`🚀 Lanzando Chrome desde: ${executablePath}`);

  const browser = await chromium.launch({
    executablePath,
    headless: false,
    args: [
      '--start-maximized',
      '--auto-open-devtools-for-tabs',
      // OJO: NO usar --disable-web-security aquí. La apiKey de Firebase está
      // restringida por HTTP-referer a vodscene.com; esa bandera hace que Chrome
      // mande las peticiones cross-origin (identitytoolkit/firestore) con Referer
      // vacío, y Google las bloquea con 403 API_KEY_HTTP_REFERRER_BLOCKED → el
      // SPA no reconoce la sesión y rebota a /login. Sin la bandera, Chrome manda
      // el Referer natural (vodscene.com) y la auth pasa.
      '--remote-debugging-port=9224', // distinto de arsmate (9222) y candies (9223)
      '--allow-running-insecure-content',
      '--ignore-certificate-errors',
      '--allow-insecure-localhost',
    ],
  });

  const context = await browser.newContext({
    viewport: null,
    bypassCSP: true,
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  // Desactivar el caché HTTP: si no, al navegar dentro del SPA Chrome serviría
  // Firestore/perfil desde caché sin pasar por nuestro interceptor.
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.setCacheDisabled', { cacheDisabled: true });

  // ─── Inyector: forzar isAdmin en el user doc de Firestore ──────────────────
  // El perfil del usuario (users/{uid}) NO llega por REST sino por el canal
  // Listen de Firestore (WebChannel: GET RID=rpc, framing <longitud>\n<chunk>).
  // Reescribir esos bytes obligaría a recalcular los prefijos de longitud y
  // rompería el streaming long-poll. En su lugar envolvemos JSON.parse: cuando
  // el SDK decodifica el frame con el user doc, mutamos el objeto YA PARSEADO
  // (isAdmin.booleanValue → true, role.stringValue → "admin"). Sin tocar los
  // bytes → sin problema de longitudes. addInitScript corre antes que el bundle,
  // así que captura nuestra versión de JSON.parse aunque la guarde en una const.
  await page.addInitScript(() => {
    const _parse = JSON.parse;
    // Muta in situ cualquier objeto de campos tipados de Firestore que tenga
    // isAdmin: {booleanValue:false}. Es el shape del user doc (ver Listen frame).
    const forceAdmin = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const x of node) forceAdmin(x); return; }
      if (node.isAdmin && typeof node.isAdmin === 'object' && 'booleanValue' in node.isAdmin) {
        if (node.isAdmin.booleanValue !== true) {
          node.isAdmin.booleanValue = true;
          if (node.role && 'stringValue' in node.role) node.role.stringValue = 'admin';
          console.log('🔥 [Injector] user doc: isAdmin→true, role→admin');
        }
      }
      for (const k in node) forceAdmin(node[k]);
    };
    JSON.parse = function (text, reviver) {
      const out = _parse(text, reviver);
      // Sólo recorremos cuando el string menciona isAdmin (el frame del user doc
      // es pequeño; el chunk gordo del catálogo no lo contiene → no lo tocamos).
      if (typeof text === 'string' && text.indexOf('"isAdmin"') !== -1) {
        try { forceAdmin(out); } catch { /* no romper el parseo del SDK */ }
      }
      return out;
    };
    console.log('🔥 [Injector] JSON.parse envuelto (isAdmin del user doc)');
  });

  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('🔥') || text.includes('[Injector]')) console.log(`[PAGE] ${text}`);
  });

  // ─── Log de toda la red a un .jsonl (para analizar la API real de vodscene) ─
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

  // ─── Interceptor: Firestore REST (desbloqueo) + inyección de Bearer ─────────
  await page.route('**/*', async (route, request) => {
    const url = request.url();

    // ─── accounts:lookup → inyectar isAdmin en el/los usuario(s) ─────────────
    // El SDK pide el perfil del usuario a accounts:lookup al arrancar. Refetchamos
    // (con Referer válido) y marcamos isAdmin=true en cada users[] para que la
    // capa de sesión del SPA habilite las vistas/acciones de admin. Sólo el POST;
    // el preflight OPTIONS cae al bloque de abajo (continue con referer).
    if (request.method() === 'POST' && /identitytoolkit\.googleapis\.com\/v1\/accounts:lookup/.test(url)) {
      try {
        const reqHeaders = { ...request.headers() };
        delete reqHeaders['host'];
        reqHeaders['referer'] = `${VODSCENE_ORIGIN}/`;
        reqHeaders['origin'] = VODSCENE_ORIGIN;

        const upstream = await fetch(url, {
          method: 'POST',
          headers: reqHeaders,
          body: request.postData() || undefined,
        });
        const data = await upstream.json();
        if (Array.isArray(data?.users)) {
          for (const u of data.users) u.isAdmin = true;
          console.log(`🔥 accounts:lookup → isAdmin=true en ${data.users.length} usuario(s)`);
        }
        route.fulfill({
          status: upstream.status,
          contentType: 'application/json',
          body: JSON.stringify(data),
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      } catch (err) {
        console.error('❌ Error interceptando accounts:lookup:', err.message);
        route.continue({
          headers: { ...request.headers(), referer: `${VODSCENE_ORIGIN}/`, origin: VODSCENE_ORIGIN },
        });
      }
      return;
    }

    // ─── Forzar Referer/Origin en las APIs de Google ─────────────────────────
    // La apiKey de Firebase está restringida por HTTP-referer a vodscene.com. El
    // SDK del navegador a veces emite estas llamadas con Referer vacío → 403. Se
    // lo imponemos aquí (identitytoolkit = auth, securetoken = refresh de token,
    // firebaseappcheck = App Check). Firestore va por su propia rama de abajo.
    if (/(identitytoolkit|securetoken|firebaseappcheck)\.googleapis\.com/.test(url)) {
      route.continue({
        headers: {
          ...request.headers(),
          referer: `${VODSCENE_ORIGIN}/`,
          origin: VODSCENE_ORIGIN,
        },
      });
      return;
    }

    if (isFirestoreRestUrl(url)) {
      try {
        const reqHeaders = { ...request.headers() };
        delete reqHeaders['host'];
        // La apiKey está restringida por referer: al refetchear desde Node hay
        // que reponer Referer/Origin de vodscene.com o Firestore da 403.
        reqHeaders['referer'] = `${VODSCENE_ORIGIN}/`;
        reqHeaders['origin'] = VODSCENE_ORIGIN;
        // Red de seguridad: si la lectura no lleva Authorization pero tenemos
        // sesión, inyectamos el Bearer para leer como usuario logueado.
        if (fbSession?.idToken && !reqHeaders['authorization']) {
          reqHeaders['authorization'] = `Bearer ${fbSession.idToken}`;
        }

        const upstream = await fetch(url, {
          method: request.method(),
          headers: reqHeaders,
          body: request.postData() || undefined,
        });

        // Firestore devuelve JSON tanto en GET como en :runQuery/:batchGet.
        const text = await upstream.text();
        let data;
        try { data = JSON.parse(text); } catch {
          // Cuerpo no-JSON (raro): reenviar tal cual.
          route.fulfill({ status: upstream.status, body: text, headers: { 'Access-Control-Allow-Origin': '*' } });
          return;
        }

        const touched = rewriteFirestoreResponse(data);
        if (touched > 0) console.log(`🔥 Firestore: ${touched} doc(s) desbloqueado(s) ← ${url.split('?')[0]}`);

        route.fulfill({
          status: upstream.status,
          contentType: 'application/json',
          body: JSON.stringify(data),
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      } catch (err) {
        console.error('❌ Error interceptando Firestore:', err.message);
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
    try { browser.close().catch(() => { }); } catch { /* ignore */ }
    process.exit(0);
  };
  page.on('close', () => shutdown('Ventana cerrada (page).'));
  context.on('close', () => shutdown('Contexto cerrado.'));
  browser.on('disconnected', () => shutdown('Navegador desconectado.'));

  // ─── Login: Firebase API + registro de sesión ──────────────────────────────
  await firebaseLogin();
  await registerUserSession();

  // Abrir el origen primero (necesario para que exista el IndexedDB del origen).
  console.log(`🌍 Abriendo: ${VODSCENE_BASE}`);
  try {
    await page.goto(VODSCENE_BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.error('❌ Error abriendo vodscene.com:', e.message);
  }

  // ─── Sembrar la sesión de Firebase en IndexedDB ────────────────────────────
  // El Firebase Web SDK guarda la sesión en la db `firebaseLocalStorageDb`
  // (store `firebaseLocalStorage`, keyPath `fbase_key`). Sembrándola, el SPA
  // arranca ya logueado sin pasar por el formulario.
  if (fbSession?.idToken) {
    try {
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
      // El SPA, al arrancar ya logueado, se auto-redirige de /login a /catalog.
      // Esa redirección aborta nuestra propia recarga con ERR_ABORTED: es la
      // señal de que la sesión fue reconocida, no un fallo. Lo toleramos.
      try {
        await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
      } catch (e) {
        if (/ERR_ABORTED|frame was detached/.test(e.message)) {
          console.log('   ↳ El SPA redirigió solo (sesión reconocida) — recarga abortada, es lo esperado.');
        } else {
          throw e;
        }
      }
    } catch (e) {
      console.error('❌ Error sembrando sesión en IndexedDB:', e.message);
    }
  }

  // Navegar al destino final si es distinto del home.
  if (TARGET_URL !== VODSCENE_BASE) {
    console.log(`🌍 Navegando a: ${TARGET_URL}`);
    try {
      await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });
    } catch (e) {
      console.error('❌ Error navigating:', e.message);
    }
  }

  console.log('✅ Navegador listo.');
  if (!fbSession) {
    console.log('   (Sin credenciales) Inicia sesión manualmente en la ventana.');
  }
  console.log('   Revisa output/network_full.jsonl para ajustar los campos de desbloqueo.');
  console.log('   (Mantén esta terminal abierta para mantener el navegador vivo)');

  await new Promise(() => { }); // keep-alive
})();
