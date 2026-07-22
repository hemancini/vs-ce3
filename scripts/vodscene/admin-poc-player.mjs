#!/usr/bin/env node
/**
 * vodscene/watch2-browser.mjs
 * Abre Chrome sobre tu página Astro /watch2 para reproducir videos de vodscene.
 * Siembra sesión Firebase + intercepta /api/vodscene/firestore para desbloquear.
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Constantes ──────────────────────────────────────────────────────────────
const VODSCENE_BASE = 'https://vodscene.com';
const VODSCENE_ORIGIN = 'https://vodscene.com';

const FIREBASE_API_KEY = 'AIzaSyAUPv7dU2kEk1rdC__6z8aGlPYPfQh_ogA';
const FIREBASE_PROJECT = 'payperview-7c21f';

const CF_REGION = 'us-central1';
const CF_REGISTER_SESSION_URL = `https://${CF_REGION}-${FIREBASE_PROJECT}.cloudfunctions.net/registerUserSession`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'output');

// ─── Credenciales ────────────────────────────────────────────────────────────
function readCred(flag, envName, fallback) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[envName] || fallback;
}
const VODSCENE_EMAIL = readCred('--email', 'VODSCENE_EMAIL', 'm45942076@gmail.com');
const VODSCENE_PASSWORD = readCred('--password', 'VODSCENE_PASSWORD', 'minasricas00');

let fbSession = null;
let deviceSessionToken = null;

// ─── Login Firebase ────────────────────────────────────────────────────────────
async function firebaseLogin() {
  if (!VODSCENE_EMAIL || !VODSCENE_PASSWORD) {
    console.warn('⚠️ Sin credenciales: login manual requerido.');
    return null;
  }
  console.log(`🔑 Login Firebase para: ${VODSCENE_EMAIL}`);
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
      console.error(`❌ Login falló (${res.status}):`, data?.error?.message || data);
      return null;
    }
    fbSession = {
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      localId: data.localId,
      email: data.email,
      expiresInSec: parseInt(data.expiresIn || '3600', 10),
    };
    console.log(`✅ Login OK. uid=${fbSession.localId}`);
    return fbSession;
  } catch (err) {
    console.error('❌ Error login:', err.message);
    return null;
  }
}

// ─── Registrar sesión de dispositivo ─────────────────────────────────────────
async function registerUserSession() {
  if (!fbSession?.idToken) return null;
  console.log('🪪 Registrando sesión de dispositivo...');
  try {
    const res = await fetch(CF_REGISTER_SESSION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${fbSession.idToken}`,
        Referer: `${VODSCENE_ORIGIN}/`,
        Origin: VODSCENE_ORIGIN,
      },
      body: JSON.stringify({ data: { deviceType: 'desktop', platform: 'web' } }),
    });
    const data = await res.json().catch(() => ({}));
    const token = data?.result?.token;
    if (!res.ok || !token) {
      console.warn(`⚠️ registerUserSession: ${res.status} sin token`);
      return null;
    }
    deviceSessionToken = token;
    console.log(`✅ Sesión registrada. sessionId=${String(data.result.sessionId).slice(0, 12)}…`);
    return token;
  } catch (err) {
    console.warn('⚠️ Error registerUserSession:', err.message);
    return null;
  }
}

// ─── Chrome ──────────────────────────────────────────────────────────────────
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
const executablePath = CHROME_PATHS.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error('❌ No se encontró Chrome. Instálalo o ajusta CHROME_PATHS.');
  process.exit(1);
}

// ─── Args ────────────────────────────────────────────────────────────────────
const TARGET_URL = process.argv.find((a) => a.startsWith('http'))
  || `${VODSCENE_BASE}/watch2?videoId=c6v8UVoh1javFNgxuC5y`;

(async () => {
  console.log(`🚀 Chrome: ${executablePath}`);
  console.log(`🎯 URL: ${TARGET_URL}`);

  const browser = await chromium.launch({
    executablePath,
    headless: false,
    args: [
      '--start-maximized',
      '--auto-open-devtools-for-tabs',
      '--remote-debugging-port=9224',
      '--allow-running-insecure-content',
      '--ignore-certificate-errors',
    ],
  });

  const context = await browser.newContext({
    viewport: null,
    bypassCSP: true,
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  // Desactivar caché
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.setCacheDisabled', { cacheDisabled: true });

  // ─── Log de red ────────────────────────────────────────────────────────────
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const logStream = fs.createWriteStream(path.join(OUTPUT_DIR, 'network_full.jsonl'), { flags: 'w' });

  page.on('response', async (response) => {
    const url = response.url();
    if (url.startsWith('data:')) return;
    try {
      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      let body = '[Binary/Large]';
      if (contentType.includes('application/json') || contentType.includes('text/')) {
        try { body = await response.text(); } catch { body = '[Error]'; }
      }
      logStream.write(JSON.stringify({
        url,
        method: response.request().method(),
        status: response.status(),
        headers,
        body: body.length > 5000 ? body.substring(0, 5000) + '...' : body,
      }) + '\n');
    } catch { /* ignore */ }
  });

  // ─── Interceptor: API interna + Firebase Auth + EZDRM ─────────────────────
  await page.route('**/*', async (route, request) => {
    const url = request.url();
    const method = request.method();

    // 0. Bloquear redirects a catalog/login
    // NO usar history.back(): dispara una tormenta de recargas (94 reloads →
    // getDoc abortado a media navegación → "client is offline"). Con el gate
    // getVideoProxyURL forzado más abajo, el app ya no debería redirigir; esto
    // queda como red de seguridad que NO navega ni recarga.
    if (url.includes('/catalog') || url.includes('/login')) {
      console.log(`🚫 Bloqueando redirect a ${url}`);
      route.fulfill({
        status: 204,
        contentType: 'text/html',
        body: '',
      });
      return;
    }

    // 0.5 getVideoProxyURL: el GATE real. La Cloud Function decide acceso
    // server-side (hasAccess:false, userData.isAdmin:false). Lo reescribimos
    // para que el app no redirija a catalog. (OJO: useDRM:true sigue requiriendo
    // licencia EZDRM válida para reproducir.)
    if (/cloudfunctions\.net\/getVideoProxyURL/.test(url)) {
      console.log(`🎬 Interceptando getVideoProxyURL: ${url}`);
      try {
        const reqHeaders = { ...request.headers() };
        delete reqHeaders['host'];
        const upstream = await fetch(url, {
          method,
          headers: reqHeaders,
          body: request.postData() || undefined,
        });
        const data = await upstream.json().catch(() => null);
        if (data?.result) {
          const r = data.result;
          r.hasAccess = true;
          r.requiresSubscription = false;
          r.requiresPurchase = false;
          if (r.userData && typeof r.userData === 'object') {
            r.userData.isAdmin = true;
            r.userData.hasSubscription = true;
            r.userData.hasPurchased = true;
            r.userData.hasAccess = true;
          }
          console.log(`🎬 getVideoProxyURL → hasAccess=true forzado`);
        }
        route.fulfill({
          status: upstream.status,
          contentType: 'application/json',
          body: JSON.stringify(data),
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      } catch (err) {
        console.error('❌ getVideoProxyURL:', err.message);
        route.continue();
      }
      return;
    }

    // 1. Interceptar /api/vodscene/firestore para inyectar datos de video
    if (url.includes('/api/vodscene/firestore')) {
      console.log(`🔥 Interceptando API interna: ${url}`);
      try {
        const reqHeaders = { ...request.headers() };
        delete reqHeaders['host'];

        const upstream = await fetch(url, {
          method,
          headers: reqHeaders,
          body: request.postData() || undefined,
        });

        let data;
        try {
          data = await upstream.json();
        } catch {
          const body = await upstream.text();
          route.fulfill({ status: upstream.status, body, headers: { 'Access-Control-Allow-Origin': '*' } });
          return;
        }

        if (data?.data?.videos) {
          for (const [videoId, doc] of Object.entries(data.data.videos)) {
            if (!doc || typeof doc !== 'object') continue;
            doc.isActive = true;
            doc.processingStatus = 'ready';
            doc.permitirPlaySinDRM = true;
            doc.hasNoDRMVersion = true;
            doc.requiresSubscription = false;
            doc.requiresPurchase = false;
            doc.isLocked = false;
            doc.locked = false;
            doc.hasAccess = true;
            doc.isPurchased = true;
            doc.unlocked = true;
            console.log(`🔥 Video ${videoId} desbloqueado`);
          }
        }

        if (data?.data?.users) {
          for (const [uid, doc] of Object.entries(data.data.users)) {
            if (!doc || typeof doc !== 'object') continue;
            doc.isAdmin = true;
            doc.role = 'admin';
            doc.isSubscribed = true;
            doc.hasSubscription = true;
            doc.isPremium = true;
            doc.isActive = true;
            console.log(`🔥 User ${uid} → admin`);
          }
        }

        route.fulfill({
          status: upstream.status,
          contentType: 'application/json',
          body: JSON.stringify(data),
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      } catch (err) {
        console.error('❌ Error API:', err.message);
        route.continue();
      }
      return;
    }

    // 2. accounts:lookup → isAdmin + emailVerified=true
    if (method === 'POST' && /identitytoolkit\.googleapis\.com\/v1\/accounts:lookup/.test(url)) {
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
          for (const u of data.users) {
            u.isAdmin = true;
            u.emailVerified = true;
            u.customAttributes = JSON.stringify({ admin: true, role: 'admin' });
            console.log(`🔥 accounts:lookup → isAdmin=true, emailVerified=true`);
          }
        }
        route.fulfill({
          status: upstream.status,
          contentType: 'application/json',
          body: JSON.stringify(data),
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      } catch (err) {
        console.error('❌ accounts:lookup:', err.message);
        route.continue();
      }
      return;
    }

    // 3. EZDRM Widevine proxy
    if (method === 'POST' && /widevine-dash\.ezdrm\.com\/proxy/.test(url)) {
      console.log(`🎹 [EZDRM] Interceptando licencia: ${url}`);
      try {
        const reqHeaders = { ...request.headers() };
        delete reqHeaders['host'];

        const urlObj = new URL(url);
        const customData = encodeURIComponent(JSON.stringify({
          userId: "RlGzEbSwVWUqwMkUno5JxeAIHk72",
          videoId: "c6v8UVoh1javFNgxuC5y"
        }));
        urlObj.searchParams.set('CustomData', customData);

        const body = request.postData() || '';
        const upstream = await fetch(urlObj.toString(), {
          method: 'POST',
          headers: reqHeaders,
          body: body.includes('CustomData') ? undefined : body,
        });

        const responseBody = await upstream.arrayBuffer();
        route.fulfill({
          status: upstream.status,
          body: Buffer.from(responseBody),
          headers: Object.fromEntries(upstream.headers),
        });
      } catch (err) {
        console.error(`❌ [EZDRM] Error:`, err.message);
        route.continue();
      }
      return;
    }

    // 4. Forzar Referer/Origin en APIs Google
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

    // 5. Firestore REST directo
    if (/firestore\.googleapis\.com/.test(url) && url.includes(`/projects/${FIREBASE_PROJECT}/`)) {
      try {
        const reqHeaders = { ...request.headers() };
        delete reqHeaders['host'];
        reqHeaders['referer'] = `${VODSCENE_ORIGIN}/`;
        reqHeaders['origin'] = VODSCENE_ORIGIN;
        if (fbSession?.idToken && !reqHeaders['authorization']) {
          reqHeaders['authorization'] = `Bearer ${fbSession.idToken}`;
        }

        const upstream = await fetch(url, { method, headers: reqHeaders, body: request.postData() || undefined });
        const text = await upstream.text();
        let data;
        try { data = JSON.parse(text); } catch {
          route.fulfill({ status: upstream.status, body: text });
          return;
        }

        const handleDoc = (doc) => {
          if (!doc?.fields) return;
          const name = doc.name || '';
          if (name.includes('/videos/')) {
            for (const k of ['isActive', 'permitirPlaySinDRM', 'hasNoDRMVersion', 'hasAccess', 'isPurchased', 'unlocked']) {
              if (doc.fields[k]) doc.fields[k] = { booleanValue: true };
            }
            for (const k of ['requiresSubscription', 'requiresPurchase', 'isLocked', 'locked']) {
              if (doc.fields[k]) doc.fields[k] = { booleanValue: false };
            }
            if (doc.fields.processingStatus) doc.fields.processingStatus = { stringValue: 'ready' };
          }
          if (name.includes('/users/')) {
            for (const k of ['isAdmin', 'isSubscribed', 'hasSubscription', 'isPremium', 'isActive', 'verified']) {
              if (doc.fields[k]) doc.fields[k] = { booleanValue: true };
            }
            if (doc.fields.role) doc.fields.role = { stringValue: 'admin' };
          }
        };

        if (Array.isArray(data)) for (const chunk of data) if (chunk?.document) handleDoc(chunk.document);
        if (data?.found?.document) handleDoc(data.found.document);
        if (data?.name && data?.fields) handleDoc(data);
        if (Array.isArray(data?.documents)) for (const d of data.documents) handleDoc(d);

        route.fulfill({
          status: upstream.status,
          contentType: 'application/json',
          body: JSON.stringify(data),
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      } catch (err) {
        console.error('❌ Firestore:', err.message);
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
    try { logStream.end(); } catch { }
    try { browser.close().catch(() => { }); } catch { }
    process.exit(0);
  };
  page.on('close', () => shutdown('Ventana cerrada.'));
  context.on('close', () => shutdown('Contexto cerrado.'));
  browser.on('disconnected', () => shutdown('Navegador desconectado.'));

  // ─── Login + Sesión ────────────────────────────────────────────────────────
  await firebaseLogin();
  await registerUserSession();

  // Sembrar cookie payperview_access_token
  if (deviceSessionToken) {
    try {
      await context.addCookies([{
        name: 'payperview_access_token',
        value: deviceSessionToken,
        domain: 'vodscene.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'Lax',
      }]);
      console.log('🍪 Cookie payperview_access_token sembrada.');
    } catch (e) {
      console.error('❌ Error cookie:', e.message);
    }
  }

  // ─── CRÍTICO: Inyectar localStorage mock ANTES de cargar la página ─────────
  // Esto evita el SecurityError porque se ejecuta en el contexto de la página
  // antes de que Firebase Auth intente leer localStorage/indexedDB
  const fbKey = `firebase:authUser:${FIREBASE_API_KEY}:[DEFAULT]`;
  const nowMs = Date.now();
  const userRecord = {
    uid: fbSession?.localId || 'LH4KxJwmTYZPgIFVZzQuoMNGzfq1',
    email: fbSession?.email || VODSCENE_EMAIL,
    emailVerified: true,
    isAnonymous: false,
    displayName: (fbSession?.email || VODSCENE_EMAIL).split('@')[0],
    photoURL: null,
    phoneNumber: null,
    providerData: [{
      providerId: 'password',
      uid: fbSession?.email || VODSCENE_EMAIL,
      displayName: (fbSession?.email || VODSCENE_EMAIL).split('@')[0],
      email: fbSession?.email || VODSCENE_EMAIL,
      phoneNumber: null,
      photoURL: null,
    }],
    stsTokenManager: {
      refreshToken: fbSession?.refreshToken || '',
      accessToken: fbSession?.idToken || '',
      expirationTime: nowMs + (fbSession?.expiresInSec || 3600) * 1000,
    },
    createdAt: String(nowMs),
    lastLoginAt: String(nowMs),
    apiKey: FIREBASE_API_KEY,
    appName: '[DEFAULT]',
  };

  // Inyectar ANTES de navegar - esto crea un mock de localStorage en memoria
  await page.addInitScript((record, key) => {
    // Crear un storage en memoria que Firebase Auth pueda usar
    const memoryStorage = new Map();
    memoryStorage.set(key, JSON.stringify(record));

    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (k) => memoryStorage.get(k) || null,
        setItem: (k, v) => memoryStorage.set(k, v),
        removeItem: (k) => memoryStorage.delete(k),
        clear: () => memoryStorage.clear(),
        key: (i) => Array.from(memoryStorage.keys())[i] || null,
        get length() { return memoryStorage.size; }
      },
      writable: true,
      configurable: true
    });

    // También interceptar indexedDB.open para que use nuestro mock
    const originalIDBOpen = indexedDB.open;
    indexedDB.open = function (...args) {
      const request = originalIDBOpen.apply(this, args);
      request.onerror = function (e) {
        // Silenciar errores de indexedDB - Firebase caerá a localStorage
        console.log('IndexedDB bloqueado, usando localStorage fallback');
      };
      return request;
    };

    // Inyectar directamente en el objeto firebase si ya existe o cuando se cree
    Object.defineProperty(window, 'firebase', {
      get() { return this._firebase; },
      set(v) {
        this._firebase = v;
        if (v && v.auth) {
          const auth = v.auth();
          if (auth) {
            // Forzar usuario logueado
            setTimeout(() => {
              if (auth.currentUser) {
                auth.currentUser.emailVerified = true;
                auth.currentUser.isAdmin = true;
              }
            }, 100);
          }
        }
      },
      configurable: true
    });
  }, userRecord, fbKey);

  // ─── Abrir vodscene.com primero ────────────────────────────────────────────
  console.log(`🌍 Abriendo origen: ${VODSCENE_BASE}`);
  try {
    await page.goto(VODSCENE_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.error('❌ Error abriendo origen:', e.message);
  }

  // ─── Navegar al target ─────────────────────────────────────────────────────
  console.log(`🌍 Navegando a: ${TARGET_URL}`);
  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.error('❌ Error navegando:', e.message);
  }

  // ─── Post-inyección: forzar el estado de auth directamente ─────────────────
  if (fbSession?.idToken) {
    try {
      await page.evaluate(({ record, key }) => {
        try {
          localStorage.setItem(key, JSON.stringify(record));
        } catch (e) {
          // El mock debería funcionar, pero por si acaso
        }

        if (window.firebase && window.firebase.auth) {
          const auth = window.firebase.auth();
          if (auth && auth.currentUser) {
            auth.currentUser.emailVerified = true;
            auth.currentUser.isAdmin = true;
            auth.currentUser.reload = () => Promise.resolve();
          }
        }
      }, { record: userRecord, key: fbKey });
      console.log('✅ Sesión inyectada en objeto auth de Firebase.');
    } catch (e) {
      console.error('❌ Error post-inyección:', e.message);
    }
  }

  // ─── Esperar Shaka Player ──────────────────────────────────────────────────
  await page.waitForFunction(() => {
    return typeof shaka !== 'undefined' && shaka.Player.isBrowserSupported();
  }, { timeout: 30000 }).catch(() => {
    console.warn('⚠️ Shaka Player no detectado a tiempo');
  });

  console.log('✅ Navegador listo. Revisa la ventana de Chrome.');
  console.log('   (Mantén esta terminal abierta)');

  await new Promise(() => { });
})();