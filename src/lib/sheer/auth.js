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
/**
 * Comprueba si `cookieHeader` sigue dando una sesión activa cargando la página
 * de un creador y detectando el formulario de login (misma heurística que el
 * scraper). Devuelve { valid, status, reason }.
 */
export async function validateSession({ cookieHeader, alias = DEFAULT_ALIAS }) {
  if (!cookieHeader) return { valid: false, status: 0, reason: 'No hay cookies' };

  const r = await rawRequest({ url: `${BASE_URL}/${alias}`, cookieHeader });
  const { status, body, location } = r;

  if (location && /\/(login|signin|sign-in)\b/i.test(location)) {
    return { valid: false, status, reason: 'Redirige al login' };
  }
  if (status === 401 || status === 403) return { valid: false, status, reason: `HTTP ${status}` };

  const looksLikeLogin =
    /type=["']?password|name=["']?password/i.test(body) && !body.includes('data-post-id');
  if (looksLikeLogin) return { valid: false, status, reason: 'Sesión expirada (página de login)' };

  // El catálogo de un creador se renderiza con data-post-id incluso para
  // invitados, así que no sirve como señal. Lo que SÍ distingue a una sesión
  // activa es el contexto de usuario (js-user) o el contenido desbloqueado
  // (<source> .mp4 inline); un invitado en su lugar recibe el CTA "guest-cta".
  const loggedIn = /js-user/i.test(body) || /<source\b[^>]*\.mp4/i.test(body);
  if (loggedIn) return { valid: true, status, reason: 'Sesión activa' };

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
 *  1. GET de la página de login → cookies iniciales (CSRF) + descubrimiento del form.
 *  2. POST de las credenciales (campos descubiertos + ocultos) → captura Set-Cookie.
 *  3. Sigue redirecciones acumulando cookies y valida la sesión resultante.
 *
 * La URL de login se puede sobreescribir con env/process.env SHEER_LOGIN_URL.
 * @returns {Promise<{ cookies: {name,value}[], cookieHeader: string }>}
 */
export async function loginSheer({ email, password, env, loginUrl } = {}) {
  if (!email || !password) throw new Error('Email y contraseña son requeridos.');

  const startUrl = loginUrl || envVar(env, 'SHEER_LOGIN_URL') || `${BASE_URL}/login`;
  const jar = new Map();

  const page = await rawRequest({ url: startUrl, cookieHeader: '' });
  applySetCookies(jar, page.setCookies);

  const form = findLoginForm(page.body);
  if (!form) {
    throw new Error(
      'No se encontró el formulario de login en la página. Define SHEER_LOGIN_URL o usa el método de cookies.',
    );
  }

  const action = resolveUrl(form.action || startUrl, startUrl);
  const fields = { ...form.hidden, [form.emailField]: email, [form.passwordField]: password };
  const bodyStr = new URLSearchParams(fields).toString();

  const post = await rawRequest({
    url: action,
    method: 'POST',
    cookieHeader: jarToHeader(jar),
    body: bodyStr,
    contentType: 'application/x-www-form-urlencoded',
    extraHeaders: { origin: BASE_URL, referer: startUrl },
  });
  applySetCookies(jar, post.setCookies);

  // Seguir hasta 4 redirecciones acumulando cookies por el camino.
  let loc = post.location;
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
    throw new Error('Login fallido: credenciales inválidas o se requiere verificación adicional.');
  }

  return { cookies: jarToCookies(jar), cookieHeader };
}

// ── Persistencia de cookies ──────────────────────────────────────────────────
const KV_KEY = 'sheer:cookies';

/** Lee las cookies guardadas (KV primero, luego config/cookies.json en dev). */
export async function loadCookies(env) {
  try {
    const raw = await env?.VS_C3_KV?.get(KV_KEY);
    if (raw) return parseCookiesInput(JSON.parse(raw));
  } catch {}
  try {
    const fs = (await import('node:fs')).default;
    const path = (await import('node:path')).default;
    const p = path.resolve(process.cwd(), 'config/cookies.json');
    if (fs.existsSync(p)) return parseCookiesInput(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch {}
  return [];
}

/**
 * Persiste las cookies en KV (VS_C3_KV → sheer:cookies) y, en dev/Node, también
 * en config/cookies.json. Devuelve qué destinos se escribieron.
 */
export async function saveCookies(cookies, env) {
  const clean = parseCookiesInput(cookies);
  const payload = JSON.stringify(clean, null, 2);
  let savedKV = false;
  let savedFile = false;

  try {
    if (env?.VS_C3_KV) {
      await env.VS_C3_KV.put(KV_KEY, payload);
      savedKV = true;
    }
  } catch {}

  try {
    const fs = (await import('node:fs')).default;
    const path = (await import('node:path')).default;
    const p = path.resolve(process.cwd(), 'config/cookies.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, payload, 'utf8');
    savedFile = true;
  } catch {}

  return { savedKV, savedFile };
}

export { DEFAULT_ALIAS };
