// src/lib/sheer/crypto.js
//
// Cifrado simétrico AES-256-GCM para los blobs que guardamos en KV (p.ej. la
// biblioteca `sheer:library`). Usa Web Crypto, disponible tanto en Cloudflare
// Workers como en Node (`astro dev`); si `globalThis.crypto.subtle` no está,
// cae al `webcrypto` de node:crypto.
//
// El secreto vive en una var/secret de Cloudflare (SHEER_KV_SECRET). Acepta una
// clave base64 de 32 bytes (uso directo) o cualquier string (se deriva con
// SHA-256). El formato de salida es compacto: "v1:<iv b64>:<ciphertext b64>".

const enc = new TextEncoder();
const dec = new TextDecoder();

async function getSubtle() {
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle;
  const { webcrypto } = await import('node:crypto');
  return webcrypto.subtle;
}

async function randomBytes(n) {
  if (globalThis.crypto?.getRandomValues) return globalThis.crypto.getRandomValues(new Uint8Array(n));
  const { webcrypto } = await import('node:crypto');
  return webcrypto.getRandomValues(new Uint8Array(n));
}

function b64encode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Importa la clave AES-256-GCM desde el secreto. Si es base64 de exactamente
// 32 bytes se usa tal cual; en cualquier otro caso se deriva con SHA-256.
async function importKey(secret) {
  const subtle = await getSubtle();
  let raw = null;
  try {
    const decoded = b64decode(secret);
    if (decoded.length === 32) raw = decoded;
  } catch {
    // No era base64 válido: derivamos por hash.
  }
  if (!raw) raw = new Uint8Array(await subtle.digest('SHA-256', enc.encode(secret)));
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Cifra bytes crudos (Uint8Array). Devuelve "v1:<iv>:<ciphertext>". */
export async function encryptBytes(bytes, secret) {
  if (!secret) throw new Error('Falta el secreto de cifrado (SHEER_KV_SECRET).');
  const subtle = await getSubtle();
  const key = await importKey(secret);
  const iv = await randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return `v1:${b64encode(iv)}:${b64encode(ct)}`;
}

/** Descifra un payload "v1:…" a bytes crudos (Uint8Array). */
export async function decryptBytes(payload, secret) {
  if (typeof payload !== 'string' || !payload.startsWith('v1:')) {
    throw new Error('Payload no cifrado o con formato inesperado.');
  }
  if (!secret) throw new Error('Falta el secreto de cifrado (SHEER_KV_SECRET).');
  const [, ivB64, ctB64] = payload.split(':');
  const subtle = await getSubtle();
  const key = await importKey(secret);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64decode(ivB64) }, key, b64decode(ctB64));
  return new Uint8Array(pt);
}

/** Cifra un string (UTF-8). Devuelve "v1:<iv>:<ciphertext>". */
export async function encryptString(text, secret) {
  return encryptBytes(enc.encode(String(text)), secret);
}

/**
 * Serializa `value` a JSON minificado y lo cifra. Devuelve el string
 * "v1:<iv>:<ciphertext>" listo para guardar en KV.
 */
export async function encryptJSON(value, secret) {
  return encryptString(JSON.stringify(value), secret); // JSON.stringify ya minifica
}

/**
 * Descifra un payload generado por encryptJSON y devuelve el objeto parseado.
 * Compatibilidad: si el payload no tiene el prefijo "v1:" se asume JSON plano
 * (datos guardados antes de activar el cifrado).
 */
export async function decryptJSON(payload, secret) {
  if (typeof payload !== 'string') return null;
  if (!payload.startsWith('v1:')) return JSON.parse(payload);
  return JSON.parse(dec.decode(await decryptBytes(payload, secret)));
}
