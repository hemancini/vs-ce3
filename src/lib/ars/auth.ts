// src/lib/ars/auth.ts
//
// Autenticación de Arsmate para la app SSR. Tres capacidades, en la línea de
// `src/lib/sheer/auth.js` pero adaptadas a Arsmate (single-account):
//   1. parseArsCookie      — normaliza una cookie pegada a mano (valor suelto,
//      "ars_mate_auth=…", cabecera "k=v; k2=v2" o JSON) al header que usa el
//      proxy/las APIs.
//   2. validateArsSession  — comprueba si una cookie sigue dando una sesión
//      activa (golpea /api/creators/search, que exige sesión).
//   3. loginArs            — inicia sesión con email/contraseña contra
//      /api/auth/login y captura la cookie `ars_mate_auth`.
//
// La sesión activa se persiste (cifrada si hay secreto) en KV `ars:session`, de
// modo que sobreviva a reinicios. El middleware (`src/lib/ars/session.ts`) la
// lee al arrancar y cae a las credenciales de entorno solo si no hay ninguna.

import { encryptJSON, decryptJSON } from '../sheer/crypto.js';

const BASE_URL = 'https://arsmate.com';
const AUTH_COOKIE = 'ars_mate_auth';
const KV_KEY = 'ars:session';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  Origin: BASE_URL,
  Referer: `${BASE_URL}/`,
};

export interface ArsSession {
  /** Cabecera de cookie lista para enviar (incluye `ars_mate_auth=…`). */
  cookie: string;
  userId?: string;
  /** Nombre mostrado en la UI (del login o el que ponga el usuario). */
  name?: string;
  /** Origen: 'login' (email/clave), 'manual' (cookie pegada) o 'env'. */
  source?: 'login' | 'manual' | 'env';
}

const envVar = (env: any, key: string): string | undefined =>
  env?.[key] || (typeof process !== 'undefined' ? (process as any).env?.[key] : undefined);

// El secreto de cifrado de KV. Reutiliza el de Sheer si no hay uno propio para
// no obligar a configurar una var nueva; si no hay ninguno, se guarda en claro.
const resolveSecret = (env: any): string | undefined =>
  envVar(env, 'ARS_KV_SECRET') || envVar(env, 'SHEER_KV_SECRET');

// ── Parseo / normalización de la cookie ──────────────────────────────────────
/**
 * Normaliza distintos formatos de entrada al header de cookie que usan las APIs:
 *  - Valor suelto del token           → `ars_mate_auth=<valor>`
 *  - "ars_mate_auth=…" o "k=v; k2=v2" → se conserva el par de auth (o el header)
 *  - JSON array `[{name,value}]` u objeto `{name:value}` (export de extensiones)
 */
export function parseArsCookie(input: unknown): string {
  if (!input) return '';
  const raw = String(input).trim();
  if (!raw) return '';

  // JSON (array de objetos u objeto plano)
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const found = parsed.find((c) => c && c.name === AUTH_COOKIE);
        if (found) return `${AUTH_COOKIE}=${found.value ?? ''}`;
        return parsed
          .filter((c) => c && c.name)
          .map((c) => `${c.name}=${c.value ?? ''}`)
          .join('; ');
      }
      if (parsed && typeof parsed === 'object') {
        if (AUTH_COOKIE in parsed) return `${AUTH_COOKIE}=${(parsed as any)[AUTH_COOKIE] ?? ''}`;
        return Object.entries(parsed)
          .map(([k, v]) => `${k}=${v ?? ''}`)
          .join('; ');
      }
    } catch {
      // No era JSON válido: seguimos al parseo de cabecera.
    }
  }

  // Cabecera "k=v; k2=v2" o pares por línea
  if (raw.includes('=')) {
    const pairs = raw
      .split(/;|\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    const authPair = pairs.find((p) => p.slice(0, p.indexOf('=')).trim() === AUTH_COOKIE);
    if (authPair) return authPair;
    return pairs.join('; ');
  }

  // Token suelto
  return `${AUTH_COOKIE}=${raw}`;
}

// ── Validación de sesión ─────────────────────────────────────────────────────
export interface ValidationResult {
  valid: boolean;
  status: number;
  reason: string;
  name?: string;
  userId?: string;
}

/**
 * Comprueba si `cookieHeader` sigue dando una sesión activa. Usa
 * /api/creators/search, que exige sesión válida (devuelve 401/500 si no la hay).
 */
export async function validateArsSession(cookieHeader: string): Promise<ValidationResult> {
  if (!cookieHeader) return { valid: false, status: 0, reason: 'No hay cookie' };
  try {
    const res = await fetch(`${BASE_URL}/api/creators/search?page=1&limit=1`, {
      headers: { ...BROWSER_HEADERS, Cookie: cookieHeader },
    });
    if (res.status === 401 || res.status === 403 || res.status === 500) {
      return { valid: false, status: res.status, reason: 'Sesión inactiva' };
    }
    if (!res.ok) return { valid: false, status: res.status, reason: `HTTP ${res.status}` };
    const data: any = await res.json().catch(() => null);
    if (data && (data.success || Array.isArray(data.creators))) {
      return { valid: true, status: res.status, reason: 'Sesión activa' };
    }
    return { valid: false, status: res.status, reason: 'Respuesta inesperada' };
  } catch (e: any) {
    return { valid: false, status: 0, reason: e?.message || 'Error de red' };
  }
}

// ── Login con email / contraseña ─────────────────────────────────────────────
/**
 * Inicia sesión en Arsmate (POST /api/auth/login con JSON) y captura la cookie
 * `ars_mate_auth`. Devuelve la sesión lista para persistir.
 */
export async function loginArs({ email, password }: { email?: string; password?: string }): Promise<ArsSession> {
  if (!email || !password) throw new Error('Email y contraseña son requeridos.');

  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    redirect: 'manual',
  });

  if (!res.ok) {
    let msg = `Login falló (HTTP ${res.status})`;
    try {
      const j: any = JSON.parse(await res.text());
      if (j?.message) msg = j.message;
    } catch {}
    throw new Error(msg);
  }

  const data: any = await res.json().catch(() => ({}));

  const setCookies =
    typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie') as string]
        : [];

  const authCookie = setCookies.find((c: string) => c.startsWith(`${AUTH_COOKIE}=`));
  if (!authCookie) throw new Error('El login no devolvió la cookie de sesión. Prueba a pegar la cookie.');

  const value = authCookie.split(';')[0].split('=').slice(1).join('=');
  const cookie = `${AUTH_COOKIE}=${value}`;

  const user = data.user || data || {};
  const userId = user.id != null ? String(user.id) : undefined;
  const name = user.name || user.username || user.displayName || email;

  return { cookie, userId, name, source: 'login' };
}

// ── Persistencia en KV (single-account) ──────────────────────────────────────
/** Lee la sesión guardada de KV `ars:session` (o null si no hay). */
export async function loadArsSession(env: any): Promise<ArsSession | null> {
  try {
    const raw = await env?.VS_C3_KV?.get(KV_KEY);
    if (raw) {
      const s = await decryptJSON(raw, resolveSecret(env));
      if (s && s.cookie) return s as ArsSession;
    }
  } catch {}
  return null;
}

/** Persiste la sesión activa en KV (cifrada si hay secreto). */
export async function saveArsSession(session: ArsSession, env: any): Promise<void> {
  if (!env?.VS_C3_KV || !session?.cookie) return;
  const secret = resolveSecret(env);
  const payload = secret ? await encryptJSON(session, secret) : JSON.stringify(session);
  await env.VS_C3_KV.put(KV_KEY, payload);
}

/** Elimina la sesión guardada de KV. */
export async function clearArsSession(env: any): Promise<void> {
  try {
    await env?.VS_C3_KV?.delete(KV_KEY);
  } catch {}
}

export { AUTH_COOKIE };
