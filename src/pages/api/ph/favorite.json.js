// POST /api/ph/favorite.json
//   body JSON: { vkey: "65e4dca4a3221", toggle?: "1" | "0" }
//   → añade (toggle=1) o quita (toggle=0) el video de los favoritos de la cuenta
//     logueada en Pornhub. Si no se pasa `toggle`, alterna respecto al estado
//     actual leído de la página.
//
// Cómo funciona: el endpoint `/video/favourite` de PH exige tres cosas que solo
// viven en la página del video y caducan: el id numérico del video, un `token`
// anti-CSRF (con marca de tiempo) y la cabecera `__m` (el id del usuario
// logueado, `liuIdOrNull`). Por eso descargamos la página fresca en cada toggle
// para extraer un token válido y luego hacemos el POST con las cookies de sesión.

import rawCookiesFallback from '../../../../scripts/ph/cookies.json';

export const prerender = false;

const BASE_URL = 'https://es.pornhub.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Cookies de age-gate, sin ellas PH sirve un stub sin el bloque GS_LIKE_FAV.
const AGE_COOKIES = {
  accessAgeDisclaimerPH: '1',
  accessAgeDisclaimerUK: '1',
  accessPH: '1',
  age_verified: '1',
  platform: 'pc',
};

async function cookieHeader(env) {
  let cookies = rawCookiesFallback;
  try {
    const raw = await env?.VS_C3_KV?.get('ph:cookies');
    if (raw) cookies = JSON.parse(raw);
  } catch {}
  const pairs = cookies.map((c) => `${c.name}=${c.value}`);
  for (const [k, v] of Object.entries(AGE_COOKIES)) pairs.push(`${k}=${v}`);
  return pairs.join('; ');
}

const BROWSER_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
  'sec-ch-ua': '"Chromium";v="120", "Not?A_Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'upgrade-insecure-requests': '1',
  'user-agent': UA,
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8', 'cache-control': 'no-store' },
  });

// Extrae de la página los datos que necesita el POST a /video/favourite.
function parsePage(html) {
  const m = html.match(/GS_LIKE_FAV\s*=\s*\{([\s\S]*?)\}\s*;/);
  const scope = m ? m[1] : html;
  const id = (scope.match(/"itemId(?:Num)?":(\d+)/) || html.match(/"video_id":(\d+)/) || [])[1];
  const isFav = (scope.match(/"isFavourite":(\d+)/) || [])[1] === '1';
  const loggedIn =
    (scope.match(/"loggedIn":(\d+)/) || html.match(/"isLoggedIn":(\d+)/) || [])[1] === '1';
  const token = (html.match(/\btoken\s*=\s*"([A-Za-z0-9._-]+)"/) ||
    html.match(/"token":"([A-Za-z0-9._-]+)"/) || [])[1];
  const liuId = (html.match(/liuIdOrNull\s*=\s*(\d+)/) || [])[1];
  return { id: id ? Number(id) : null, isFav, loggedIn, token, liuId };
}

export const POST = async ({ request, locals }) => {
  const env = locals?.runtime?.env;

  let body;
  try { body = await request.json(); } catch {}
  const vkey = body?.vkey;
  if (!vkey) return json({ error: 'Falta vkey' }, 400);

  const pageUrl = `${BASE_URL}/view_video.php?viewkey=${encodeURIComponent(vkey)}`;
  const cookie = await cookieHeader(env);

  let page;
  try {
    const res = await fetch(pageUrl, { headers: { ...BROWSER_HEADERS, cookie }, redirect: 'follow' });
    page = parsePage(await res.text());
  } catch (e) {
    return json({ error: 'No se pudo cargar la página del video: ' + e.message }, 502);
  }

  if (!page.loggedIn) return json({ error: 'No hay sesión iniciada en Pornhub', loggedIn: false }, 401);
  if (!page.id || !page.token) return json({ error: 'No se encontró id/token del video' }, 502);

  // Toggle explícito del cliente o, si no, el opuesto al estado actual.
  const toggle =
    body.toggle === '1' || body.toggle === 1 ? '1'
    : body.toggle === '0' || body.toggle === 0 ? '0'
    : page.isFav ? '0' : '1';

  try {
    const res = await fetch(`${BASE_URL}/video/favourite`, {
      method: 'POST',
      headers: {
        accept: '*/*',
        'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
        'content-type': 'application/json',
        'user-agent': UA,
        origin: BASE_URL,
        referer: pageUrl,
        'x-requested-with': 'XMLHttpRequest',
        ...(page.liuId ? { __m: String(page.liuId) } : {}),
        cookie,
      },
      body: JSON.stringify({ toggle, id: page.id, token: page.token }),
    });

    const data = await res.json().catch(() => ({}));
    const success = data.success === 'true' || data.success === true;
    return json({
      success,
      action: data.action || (toggle === '1' ? 'add' : 'remove'),
      isFavourite: toggle === '1',
      message: data.message || '',
    });
  } catch (e) {
    return json({ error: 'Error al alternar favorito: ' + e.message }, 502);
  }
};
