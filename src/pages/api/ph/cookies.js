// GET  /api/ph/cookies
//   → devuelve las cookies actuales desde KV
//   Respuesta: { cookies: [...], fromStorage: 'kv' } o { cookies: null, fromStorage: 'none' }
//
// PUT  /api/ph/cookies
//   body JSON: { cookies: [...] }
//   → guarda las cookies en KV (protegido por el middleware de autenticación)
//   Respuesta: { ok: true, count }

export const prerender = false;

const KV_KEY = 'ph:cookies';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8', 'cache-control': 'no-store' },
  });

function getKV(context) {
  return context.locals?.runtime?.env?.VS_C3_KV ?? null;
}

export const GET = async (context) => {
  const kv = getKV(context);
  if (!kv) return json({ error: 'KV no configurado' }, 503);

  try {
    const raw = await kv.get(KV_KEY);
    if (!raw) return json({ cookies: null, fromStorage: 'none', count: 0 });
    const cookies = JSON.parse(raw);
    return json({ cookies, fromStorage: 'kv', count: cookies.length });
  } catch (e) {
    return json({ error: 'Error al leer KV: ' + e.message }, 500);
  }
};

// POST /api/ph/cookies
//   body JSON: { cookies: [...] }
//   → verifica si las cookies abren sesión válida en es.pornhub.com
//   Respuesta: { valid: bool, username?: string, reason?: string }
export const POST = async (context) => {
  let body;
  try { body = await context.request.json(); } catch {}

  const cookieList = body?.cookies;
  if (!Array.isArray(cookieList) || !cookieList.length) {
    return json({ valid: false, reason: 'Sin cookies para validar' });
  }

  const AGE_COOKIES = {
    accessAgeDisclaimerPH: '1',
    accessAgeDisclaimerUK: '1',
    accessPH: '1',
    age_verified: '1',
    platform: 'pc',
  };

  const parts = cookieList
    .filter((c) => c.name && c.value !== undefined)
    .map((c) => `${c.name}=${c.value}`);
  for (const [k, v] of Object.entries(AGE_COOKIES)) parts.push(`${k}=${v}`);
  const cookieHeader = parts.join('; ');

  try {
    const res = await fetch('https://es.pornhub.com/', {
      redirect: 'follow',
      headers: {
        cookie: cookieHeader,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
      },
    });

    if (!res.ok) return json({ valid: false, reason: `HTTP ${res.status}` });

    const html = await res.text();

    const valid =
      /isLoggedIn\s*[=:]\s*[1"']/.test(html) ||
      html.includes('"isLogged":1') ||
      html.includes('class="userLoggedIn"');

    let username = null;
    for (const re of [/"username"\s*:\s*"([^"]+)"/, /class="[^"]*username[^"]*"[^>]*>\s*([^<\s][^<]{0,40})/]) {
      const m = html.match(re);
      if (m?.[1]) { username = m[1].trim(); break; }
    }

    return json({ valid, username });
  } catch (e) {
    return json({ error: 'Error al conectar con Pornhub: ' + e.message }, 500);
  }
};

export const PUT = async (context) => {
  const kv = getKV(context);
  if (!kv) return json({ error: 'KV no configurado — crea el namespace y actualiza wrangler.toml' }, 503);

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Body JSON inválido' }, 400);
  }

  const { cookies } = body ?? {};
  if (!Array.isArray(cookies)) return json({ error: 'cookies debe ser un array JSON' }, 400);

  await kv.put(KV_KEY, JSON.stringify(cookies));
  return json({ ok: true, count: cookies.length });
};
