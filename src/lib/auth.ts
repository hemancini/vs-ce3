/** Duración máxima de sesión: 2 horas */
export const SESSION_MAX_MS = 2 * 60 * 60 * 1000;

/** Nombre de la cookie de sesión (HttpOnly) */
export const COOKIE_NAME = "vs_token";

// ─── Helpers Web Crypto (disponible en Cloudflare Workers y Node.js 19+) ───────

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const pairs = hex.match(/.{2}/g);
  if (!pairs) return new Uint8Array(0);
  return new Uint8Array(pairs.map((b) => parseInt(b, 16)));
}

// ─── API pública ───────────────────────────────────────────────────────────────

/**
 * Genera un token firmado con HMAC-SHA256.
 * Formato: `<expiry_unix_ms>.<hmac_hex>`
 */
export async function signToken(apiKey: string): Promise<string> {
  const expiry = Date.now() + SESSION_MAX_MS;
  const key = await importHmacKey(apiKey);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(String(expiry))
  );
  return `${expiry}.${toHex(sig)}`;
}

/**
 * Verifica que el token sea válido y no haya expirado.
 * Retorna `false` ante cualquier error o expiración.
 */
export async function verifyToken(
  token: string,
  apiKey: string
): Promise<boolean> {
  try {
    const dot = token.indexOf(".");
    if (dot === -1) return false;

    const expiryStr = token.slice(0, dot);
    const sigHex = token.slice(dot + 1);
    const expiry = Number(expiryStr);

    // Verificar expiración
    if (!Number.isFinite(expiry) || Date.now() > expiry) return false;

    // Verificar firma
    const key = await importHmacKey(apiKey);
    return crypto.subtle.verify(
      "HMAC",
      key,
      fromHex(sigHex),
      new TextEncoder().encode(expiryStr)
    );
  } catch {
    return false;
  }
}
