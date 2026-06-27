// ─── Firebase Auth con caché de token ─────────────────────────────────────────
// El idToken de Firebase dura 1 hora. Este módulo lo cachea en memoria
// (module-level, comparte instancia dentro del mismo Worker) y solo vuelve
// a hacer sign-in cuando el token está por expirar (margen de 5 min).

interface TokenCache {
  idToken: string;
  expiresAt: number; // ms epoch
}

// Cache a nivel de módulo, indexado por email — persiste mientras vive el isolate
// de Cloudflare Workers. Indexar por email evita devolver el token de otra cuenta
// tras un cambio de cuenta activa (multicuenta).
const cache = new Map<string, TokenCache>();

const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 minutos antes del vencimiento

export interface FirebaseCredentials {
  apiKey: string;
  email: string;
  password: string;
}

/**
 * Devuelve un idToken válido de Firebase.
 * Reutiliza el token cacheado si todavía es válido; de lo contrario hace sign-in.
 */
export async function getFirebaseToken(creds: FirebaseCredentials): Promise<string> {
  const now = Date.now();
  const key = creds.email;

  // Token válido aún para esta cuenta
  const cached = cache.get(key);
  if (cached && cached.expiresAt - now > REFRESH_MARGIN_MS) {
    return cached.idToken;
  }

  // Necesita (re)login
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${creds.apiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Referer":  "https://vodscene.com/",
        "Origin":   "https://vodscene.com",
      },
      body: JSON.stringify({
        email: creds.email,
        password: creds.password,
        returnSecureToken: true,
      }),
    }
  );

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Firebase login failed (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as { idToken: string; expiresIn: string };

  const ttlMs = parseInt(data.expiresIn, 10) * 1000; // expiresIn viene en segundos ("3600")
  cache.set(key, {
    idToken:   data.idToken,
    expiresAt: now + ttlMs,
  });

  return data.idToken;
}

/**
 * Invalida el cache de token. Sin argumento limpia todas las cuentas (p. ej. al
 * cambiar de cuenta activa); con email invalida solo esa cuenta.
 */
export function invalidateFirebaseToken(email?: string): void {
  if (email) cache.delete(email);
  else cache.clear();
}
