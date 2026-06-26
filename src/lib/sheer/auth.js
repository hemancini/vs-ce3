// src/lib/sheer/auth.js
//
// Autenticación de Sheer para la app SSR. Tres capacidades:
//   1. parseCookiesInput  — normaliza cookies pegadas a mano (JSON, header "k=v; …"
//      o el export de cookies.json) a [{name, value}].
//   2. validateSession    — comprueba si una cabecera de cookies sigue dando una
//      sesión activa (carga una página de creador y busca el form de login).
//   3. loginSheer         — inicia sesión con email/contraseña, descubriendo el
//      formulario de login en la página y capturando las Set-Cookie resultantes.
//
// Como el scraper, usa fetch nativo y cae a node:https con maxHeaderSize ampliado
// cuando el fetch de undici revienta por exceso de cabeceras Set-Cookie (Node/dev;
// en Cloudflare Workers el fetch nativo maneja bien las cabeceras grandes).

import { parse } from 'node-html-parser';
import { encryptJSON, decryptJSON } from './crypto.js';

const BASE_URL = 'https://www.sheer.com';
const DEFAULT_ALIAS = 'TheGrey';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
  'user-agent': UA,
};

const envVar = (env, key) =>
  env?.[key] || (typeof process !== 'undefined' ? process.env?.[key] : undefined);

// ── Parseo / serialización de cookies ────────────────────────────────────────
/**
 * Normaliza distintos formatos de entrada a [{name, value}]:
 *  - Array de objetos `{name, value, …}` (export de cookies.json / extensiones)
 *  - JSON objeto `{name: value}`
 *  - Cabecera "k=v; k2=v2" o pares separados por salto de línea
 */
export function parseCookiesInput(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.filter((c) => c && c.name).map((c) => ({ name: String(c.name), value: String(c.value ?? '') }));
  }
  const text = String(input).trim();
  if (!text) return [];

  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.filter((c) => c && c.name).map((c) => ({ name: String(c.name), value: String(c.value ?? '') }));
      }
      if (parsed && typeof parsed === 'object') {
        return Object.entries(parsed).map(([name, value]) => ({ name, value: String(value ?? '') }));
      }
    } catch {
      // No era JSON válido: seguimos al parseo de cabecera.
    }
  }

  return text
    .split(/;|\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return null;
      const name = pair.slice(0, eq).trim();
      if (!name || name.toLowerCase() === 'cookie') return null;
      return { name, value: pair.slice(eq + 1).trim() };
    })
    .filter((c) => c && c.name);
}

export function cookiesToHeader(cookies) {
  return (cookies || [])
    .filter((c) => c && c.name)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

// Tarro de cookies como Map name->value, alimentado por cabeceras Set-Cookie.
function applySetCookies(jar, setCookies) {
  for (const sc of setCookies || []) {
    const first = String(sc).split(';')[0];
    const eq = first.indexOf('=');
    if (eq < 0) continue;
    const name = first.slice(0, eq).trim();
    if (!name) continue;
    const value = first.slice(eq + 1).trim();
    if (value === '' || value === 'deleted') jar.delete(name);
    else jar.set(name, value);
  }
}

const jarToCookies = (jar) => [...jar.entries()].map(([name, value]) => ({ name, value }));
const jarToHeader = (jar) => [...jar.entries()].map(([n, v]) => `${n}=${v}`).join('; ');

// ── Request de bajo nivel con captura de Set-Cookie ──────────────────────────
function isHeaderOverflow(err) {
  const code = err?.code || err?.cause?.code;
  return (
    code === 'UND_ERR_HEADERS_OVERFLOW' ||
    /headers? overflow/i.test(err?.message || '') ||
    /headers? overflow/i.test(err?.cause?.message || '')
  );
}

async function nodeRequest({ url, method = 'GET', cookieHeader = '', body = null, contentType, extraHeaders = {} }) {
  const https = (await import('node:https')).default;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { ...BROWSER_HEADERS, ...extraHeaders };
    if (cookieHeader) headers.cookie = cookieHeader;
    if (body != null) {
      headers['content-type'] = contentType || 'application/x-www-form-urlencoded';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, maxHeaderSize: 256 * 1024, headers },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { data += d; });
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            location: res.headers.location || '',
            setCookies: res.headers['set-cookie'] || [],
            body: data,
          }),
        );
      },
    );
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function fetchRequest({ url, method = 'GET', cookieHeader = '', body = null, contentType, extraHeaders = {} }) {
  const headers = { ...BROWSER_HEADERS, ...extraHeaders };
  if (cookieHeader) headers.cookie = cookieHeader;
  if (contentType) headers['content-type'] = contentType;
  const res = await fetch(url, { method, headers, body, redirect: 'manual' });
  const setCookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie')]
        : [];
  return {
    status: res.status,
    location: res.headers.get('location') || '',
    setCookies,
    body: await res.text(),
  };
}

let preferNodeHttps = false;

async function rawRequest(opts) {
  if (preferNodeHttps) return nodeRequest(opts);
  try {
    return await fetchRequest(opts);
  } catch (err) {
    if (isHeaderOverflow(err)) {
      preferNodeHttps = true;
      return nodeRequest(opts);
    }
    throw err;
  }
}

// ── Validación de sesión ─────────────────────────────────────────────────────
// Extrae el objeto `auth` del bloque inline `APP_CONFIG = {…}` de la página.
// Trae el contexto del usuario logueado: { is_guest, display_name,
// website_user_id, … }. Es la señal de sesión más fiable y, de paso, nos da el
// nombre real de la cuenta. Escanea llaves balanceadas para recortar el JSON.
function parseAppConfigAuth(html) {
  const m = /APP_CONFIG\s*=\s*/.exec(html);
  if (!m) return null;
  let i = m.index + m[0].length;
  if (html[i] !== '{') return null;
  const start = i;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      if (--depth === 0) { i++; break; }
    }
  }
  try {
    const cfg = JSON.parse(html.slice(start, i));
    return cfg && cfg.auth ? cfg.auth : null;
  } catch {
    return null;
  }
}

/**
 * Comprueba si `cookieHeader` sigue dando una sesión activa cargando la página
 * de un creador. Prefiere el contexto `APP_CONFIG.auth` (fiable y con el nombre
 * del usuario) y cae a la heurística de markup si no está.
 * Devuelve { valid, status, reason, name, userId }.
 */
export async function validateSession({ cookieHeader, alias = DEFAULT_ALIAS }) {
  if (!cookieHeader) return { valid: false, status: 0, reason: 'No hay cookies' };

  const r = await rawRequest({ url: `${BASE_URL}/${alias}`, cookieHeader });
  const { status, body, location } = r;

  if (location && /\/(login|signin|sign-in)\b/i.test(location)) {
    return { valid: false, status, reason: 'Redirige al login' };
  }
  if (status === 401 || status === 403) return { valid: false, status, reason: `HTTP ${status}` };

  // Señal primaria: el contexto de usuario de APP_CONFIG.
  const auth = parseAppConfigAuth(body);
  if (auth && typeof auth.is_guest === 'boolean') {
    const name = auth.display_name ? String(auth.display_name) : '';
    const userId = auth.website_user_id ?? null;
    if (!auth.is_guest) return { valid: true, status, reason: 'Sesión activa', name, userId };
    return { valid: false, status, reason: 'Sesión inactiva (invitado)', name: '', userId: null };
  }

  // Fallback heurístico (por si cambia el HTML y no hay APP_CONFIG legible).
  const looksLikeLogin =
    /type=["']?password|name=["']?password/i.test(body) && !body.includes('data-post-id');
  if (looksLikeLogin) return { valid: false, status, reason: 'Sesión expirada (página de login)' };

  const loggedIn = /js-user/i.test(body) || /<source\b[^>]*\.mp4/i.test(body);
  if (loggedIn) return { valid: true, status, reason: 'Sesión activa', name: '', userId: null };

  const guestOnly = /guest-cta|is_guest/i.test(body);
  return { valid: false, status, reason: guestOnly ? 'Sesión inactiva (invitado)' : 'No se detectó sesión activa' };
}

// ── Login con email / contraseña ─────────────────────────────────────────────
const resolveUrl = (href, base) => {
  try { return new URL(href, base).toString(); } catch { return href; }
};

// Localiza el <form> que contiene el campo de contraseña y extrae su action, los
// inputs ocultos (incluido el token CSRF) y los nombres de los campos email/clave.
function findLoginForm(html) {
  const root = parse(html);
  const forms = root.querySelectorAll('form');
  for (const form of forms) {
    const pwd = form.querySelector('input[type="password"]');
    if (!pwd) continue;

    const passwordField = pwd.getAttribute('name');
    if (!passwordField) continue;

    const hidden = {};
    form.querySelectorAll('input[type="hidden"]').forEach((inp) => {
      const name = inp.getAttribute('name');
      if (name) hidden[name] = inp.getAttribute('value') || '';
    });

    let emailField = '';
    for (const inp of form.querySelectorAll('input')) {
      const type = (inp.getAttribute('type') || 'text').toLowerCase();
      const name = inp.getAttribute('name');
      if (!name || name === passwordField) continue;
      if (type === 'email') { emailField = name; break; }
      if ((type === 'text') && !emailField) emailField = name;
    }
    if (!emailField) continue;

    return { action: form.getAttribute('action') || '', hidden, emailField, passwordField };
  }
  return null;
}

/**
 * Inicia sesión en Sheer con email/contraseña. Flujo:
 *  1. GET del formulario del diálogo (/profile/login/form) → cookies + CSRF +
 *     el campo oculto `redirect`. Cae al /login clásico si no responde.
 *  2. POST de las credenciales al endpoint AJAX. OJO: el servidor valida el
 *     campo `redirect` (isOurWebsiteUrl) ANTES que las credenciales, así que
 *     debe ser una URL del propio dominio o devuelve "Wrong domain for url".
 *  3. La respuesta es JSON: si trae result:error se propaga su mensaje
 *     (CAPTCHA requerido, login con Google, credenciales…). Si es éxito, sigue
 *     las redirecciones, acumula cookies y valida la sesión.
 *
 * La URL del formulario se puede sobreescribir con env/process.env SHEER_LOGIN_URL.
 * @returns {Promise<{ cookies: {name,value}[], cookieHeader: string }>}
 */
export async function loginSheer({ email, password, env, loginUrl } = {}) {
  if (!email || !password) throw new Error('Email y contraseña son requeridos.');

  const jar = new Map();
  const ajaxHeaders = { 'x-requested-with': 'XMLHttpRequest', referer: `${BASE_URL}/` };

  // 1. Cargar el formulario del diálogo (trae el campo `redirect`); si falla,
  //    caer a la página /login completa.
  const formUrl = loginUrl || envVar(env, 'SHEER_LOGIN_URL') || `${BASE_URL}/profile/login/form`;
  let page = await rawRequest({ url: formUrl, cookieHeader: '', extraHeaders: ajaxHeaders });
  applySetCookies(jar, page.setCookies);
  let form = findLoginForm(page.body);
  if (!form) {
    page = await rawRequest({ url: `${BASE_URL}/login`, cookieHeader: jarToHeader(jar) });
    applySetCookies(jar, page.setCookies);
    form = findLoginForm(page.body);
  }
  if (!form) {
    throw new Error('No se encontró el formulario de login. Usa el método de pegar cookies.');
  }

  // 2. Construir el cuerpo. El campo `redirect` debe ser una URL del dominio.
  const action = resolveUrl(form.action || `${BASE_URL}/profile/login`, BASE_URL);
  const hidden = { ...form.hidden };
  if ('redirect' in hidden && !hidden.redirect) hidden.redirect = `${BASE_URL}/`;
  const fields = { ...hidden, [form.emailField]: email, [form.passwordField]: password };
  const bodyStr = new URLSearchParams(fields).toString();

  const post = await rawRequest({
    url: action,
    method: 'POST',
    cookieHeader: jarToHeader(jar),
    body: bodyStr,
    contentType: 'application/x-www-form-urlencoded',
    extraHeaders: { ...ajaxHeaders, origin: BASE_URL },
  });
  applySetCookies(jar, post.setCookies);

  // 3. Respuesta JSON del endpoint AJAX: traducir errores a mensajes claros.
  let data = null;
  try {
    data = JSON.parse(post.body);
  } catch {}
  if (data && data.result === 'error') {
    if (data.need_show_captcha) {
      throw new Error('Sheer pide completar un CAPTCHA. Inicia sesión en el navegador y usa el método de pegar cookies.');
    }
    if (data.result_status === 'social_network_required') {
      throw new Error('Esta cuenta inicia sesión con Google. Usa el método de pegar cookies.');
    }
    throw new Error((data.message || '').trim() || 'El servidor rechazó el inicio de sesión.');
  }

  // Éxito: seguir la redirección (location o redirect del JSON) acumulando cookies.
  let loc = post.location || (data && (data.redirect || data.url)) || '';
  let hops = 0;
  let current = action;
  while (loc && hops < 4) {
    const next = resolveUrl(loc, current);
    const r = await rawRequest({ url: next, cookieHeader: jarToHeader(jar) });
    applySetCookies(jar, r.setCookies);
    current = next;
    loc = r.location;
    hops++;
  }

  const cookieHeader = jarToHeader(jar);
  const check = await validateSession({ cookieHeader, env });
  if (!check.valid) {
    throw new Error('Login fallido: no se obtuvo una sesión válida. Prueba el método de pegar cookies.');
  }

  return { cookies: jarToCookies(jar), cookieHeader, name: check.name || '' };
}

// ── Persistencia de cookies (multicuenta) ────────────────────────────────────
// Todo vive en KV (VS_C3_KV). Dos claves:
//   · sheer:accounts  → store multicuenta { accounts:[{id,label,cookies,createdAt}], activeId }
//   · sheer:cookies   → cookies de la cuenta ACTIVA en formato legacy [{name,value}],
//                       que es lo que lee el scraper (así no necesita cambios).
const KV_KEY = 'sheer:cookies'; // cookies de la cuenta activa (lo lee el scraper)
const KV_ACCOUNTS = 'sheer:accounts'; // store multicuenta

// Todo lo que se persiste en KV va minificado y cifrado (AES-256-GCM) con la
// var/secret SHEER_KV_SECRET de Cloudflare. La lectura tolera datos en texto
// plano (passthrough) para no romper lo guardado antes de activar el cifrado.
const resolveSecret = (env) => envVar(env, 'SHEER_KV_SECRET');

const genId = () => `acc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// Sanea un store crudo: ids/labels string, cookies normalizadas, activeId válido.
function normalizeStore(store) {
  const accounts = (Array.isArray(store?.accounts) ? store.accounts : [])
    .filter((a) => a && a.id)
    .map((a) => ({
      id: String(a.id),
      label: String(a.label || a.id),
      cookies: parseCookiesInput(a.cookies),
      createdAt: a.createdAt || Date.now(),
    }));
  let activeId = store?.activeId || null;
  if (activeId && !accounts.some((a) => a.id === activeId)) activeId = null;
  if (!activeId && accounts.length) activeId = accounts[0].id;
  return { accounts, activeId };
}

/** Vista pública del store: oculta las cookies, expone solo metadatos. */
export function sanitizeAccounts(store) {
  return (store?.accounts || []).map((a) => ({
    id: a.id,
    label: a.label,
    count: (a.cookies || []).length,
    active: a.id === store.activeId,
  }));
}

// Cookies guardadas en el formato legacy (single-account) en KV `sheer:cookies`.
async function loadLegacyCookies(env) {
  try {
    const raw = await env?.VS_C3_KV?.get(KV_KEY);
    if (raw) return parseCookiesInput(await decryptJSON(raw, resolveSecret(env)));
  } catch {}
  return [];
}

/**
 * Lee el store multicuenta de KV. Si aún no existe, migra el formato legacy
 * (`sheer:cookies`) a una única cuenta «Principal» para no perder la sesión.
 */
export async function loadAccounts(env) {
  try {
    const raw = await env?.VS_C3_KV?.get(KV_ACCOUNTS);
    if (raw) {
      const store = normalizeStore(await decryptJSON(raw, resolveSecret(env)));
      if (store.accounts.length) return store;
    }
  } catch {}
  const legacy = await loadLegacyCookies(env);
  if (legacy.length) {
    const id = genId();
    return { accounts: [{ id, label: 'Principal', cookies: legacy, createdAt: Date.now() }], activeId: id };
  }
  return { accounts: [], activeId: null };
}

/**
 * Persiste el store multicuenta en KV (`sheer:accounts`) y refleja la cuenta
 * activa en `sheer:cookies` para que lo lea el scraper.
 */
export async function saveAccounts(store, env) {
  const norm = normalizeStore(store);
  let savedKV = false;

  if (env?.VS_C3_KV) {
    const payload = await encryptJSON(norm, resolveSecret(env)); // minificado + cifrado
    await env.VS_C3_KV.put(KV_ACCOUNTS, payload);
    savedKV = true;
  }

  // Reflejar la cuenta activa en el formato legacy (sheer:cookies).
  const active = norm.accounts.find((a) => a.id === norm.activeId);
  await saveCookies(active ? active.cookies : [], env);

  return { savedKV, store: norm };
}

/**
 * Añade una cuenta nueva (o reemplaza las cookies de una existente con el mismo
 * nombre) y la marca como activa. Devuelve { id, store }.
 */
export async function upsertAccount({ label, cookies }, env) {
  const store = await loadAccounts(env);
  const clean = parseCookiesInput(cookies);
  const lbl = String(label || '').trim();
  let acc = lbl ? store.accounts.find((a) => a.label.toLowerCase() === lbl.toLowerCase()) : null;
  if (acc) {
    acc.cookies = clean;
  } else {
    acc = { id: genId(), label: lbl || `Cuenta ${store.accounts.length + 1}`, cookies: clean, createdAt: Date.now() };
    store.accounts.push(acc);
  }
  store.activeId = acc.id;
  const { store: saved } = await saveAccounts(store, env);
  return { id: acc.id, store: saved };
}

/** Cambia la cuenta activa por id. Lanza si no existe. */
export async function setActiveAccount(id, env) {
  const store = await loadAccounts(env);
  if (!store.accounts.some((a) => a.id === id)) throw new Error('Cuenta no encontrada');
  store.activeId = id;
  const { store: saved } = await saveAccounts(store, env);
  return saved;
}

/** Renombra una cuenta por id. No-op si no existe o el nombre está vacío. */
export async function renameAccount(id, label, env) {
  const lbl = String(label || '').trim();
  if (!lbl) return null;
  const store = await loadAccounts(env);
  const acc = store.accounts.find((a) => a.id === id);
  if (!acc || acc.label === lbl) return store;
  acc.label = lbl;
  const { store: saved } = await saveAccounts(store, env);
  return saved;
}

/** Elimina una cuenta; si era la activa, pasa a la primera disponible. */
export async function removeAccount(id, env) {
  const store = await loadAccounts(env);
  store.accounts = store.accounts.filter((a) => a.id !== id);
  if (store.activeId === id) store.activeId = store.accounts[0]?.id || null;
  const { store: saved } = await saveAccounts(store, env);
  return saved;
}

/** Cookies de la cuenta activa (las usan validateSession / el scraper). */
export async function loadCookies(env) {
  const { accounts, activeId } = await loadAccounts(env);
  const active = accounts.find((a) => a.id === activeId);
  return active ? active.cookies : [];
}

/**
 * Persiste cookies sueltas en KV `sheer:cookies` (formato legacy de la cuenta
 * activa). Lo usa `saveAccounts` para reflejar la cuenta activa al scraper.
 */
export async function saveCookies(cookies, env) {
  const clean = parseCookiesInput(cookies);
  let savedKV = false;

  if (env?.VS_C3_KV) {
    const payload = await encryptJSON(clean, resolveSecret(env)); // minificado + cifrado
    await env.VS_C3_KV.put(KV_KEY, payload);
    savedKV = true;
  }

  return { savedKV };
}

export { DEFAULT_ALIAS };
