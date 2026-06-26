// src/lib/ph/cookies.js
//
// Acceso centralizado a las cookies/cuentas de Pornhub en KV (VS_C3_KV), con
// cifrado AES-256-GCM en reposo (mismo esquema que Sheer, src/lib/sheer/crypto.js).
//
// Claves en KV:
//   · ph:cookies  → cookies de la cuenta ACTIVA [{name,value,domain}] (lo leen
//                   el scraper y las páginas SSR).
//   · ph:accounts → store multicuenta { accounts:[…], activeId }.
//
// El secreto se toma de PH_KV_SECRET y, si no existe, de SHEER_KV_SECRET (ya
// configurado). Si no hay secreto, se guarda en texto plano (degradación segura
// para entornos sin secreto). La lectura tolera datos antiguos sin cifrar gracias
// al passthrough de decryptJSON.

import { encryptJSON, decryptJSON } from '../sheer/crypto.js';

export const PH_KV_COOKIES = 'ph:cookies';
export const PH_KV_ACCOUNTS = 'ph:accounts';

const envVar = (env, key) =>
  env?.[key] || (typeof process !== 'undefined' ? process.env?.[key] : undefined);

export const resolvePhSecret = (env) => envVar(env, 'PH_KV_SECRET') || envVar(env, 'SHEER_KV_SECRET');

/** Lee y descifra una clave JSON de KV. Devuelve null si no existe o falla. */
export async function readPhKV(kv, key, env) {
  if (!kv) return null;
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return await decryptJSON(raw, resolvePhSecret(env));
  } catch {
    // Último recurso: intentar como JSON plano (datos previos al cifrado).
    try { return JSON.parse(raw); } catch { return null; }
  }
}

/** Serializa, cifra (si hay secreto) y guarda un valor JSON en KV. */
export async function writePhKV(kv, key, value, env) {
  const secret = resolvePhSecret(env);
  const payload = secret ? await encryptJSON(value, secret) : JSON.stringify(value);
  await kv.put(key, payload);
}

/** Cookies de la cuenta activa (array). [] si no hay. */
export async function loadPhCookies(env) {
  const data = await readPhKV(env?.VS_C3_KV, PH_KV_COOKIES, env);
  return Array.isArray(data) ? data : [];
}

/** Guarda las cookies de la cuenta activa (cifradas). */
export async function savePhCookies(cookies, env) {
  await writePhKV(env?.VS_C3_KV, PH_KV_COOKIES, Array.isArray(cookies) ? cookies : [], env);
}

/**
 * Metadatos para la UI (CookieManager): si hay cookies en KV y cuántas, sin
 * exponer los valores. fromKV refleja la mera presencia de la clave en KV.
 */
export async function phCookieMeta(env) {
  const kv = env?.VS_C3_KV;
  if (!kv) return { cookieFromKV: false, cookieCount: 0 };
  try {
    const raw = await kv.get(PH_KV_COOKIES);
    if (!raw) return { cookieFromKV: false, cookieCount: 0 };
    const data = await decryptJSON(raw, resolvePhSecret(env));
    return { cookieFromKV: true, cookieCount: Array.isArray(data) ? data.length : 0 };
  } catch {
    return { cookieFromKV: false, cookieCount: 0 };
  }
}
