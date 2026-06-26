// POST /api/ph/subscribe.json
//   body JSON: { vkey: "65d385a07c1d1", subscribe?: true | false }
//   → suscribe (subscribe=true) o cancela (subscribe=false) la suscripción al
//     canal/modelo que subió el video. Sin `subscribe`, alterna respecto al
//     estado actual leído de la página.
//
// Igual que favoritos, PH exige datos que solo viven en la página y caducan: el
// id del uploader, un `token` anti-CSRF y la cabecera `__m` (id del usuario
// logueado). El botón de la página trae `data-subscribe-url` ya apuntando al
// endpoint correcto (subscribe_add_json / subscribe_remove_json) según el estado
// actual, así que descargamos la página fresca y reutilizamos esa URL.

import { loadPhCookies } from '../../../lib/ph/cookies.js';

export const prerender = false;

const BASE_URL = 'https://es.pornhub.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const AGE_COOKIES = {
  accessAgeDisclaimerPH: '1',
  accessAgeDisclaimerUK: '1',
  accessPH: '1',
  age_verified: '1',
  platform: 'pc',
};

async function cookieHeader(env) {
  let cookies = [];
  try { cookies = await loadPhCookies(env); } catch {}
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

// Datos del botón de suscripción embebido en la página.
function parsePage(html) {
  const subscribeUrl = (html.match(/data-subscribe-url="([^"]+)"/) || [])[1];
  const subscribed = (html.match(/data-subscribed="(\d)"/) || [])[1] === '1';
  const loggedIn =
    (html.match(/"loggedIn":(\d+)/) || html.match(/"isLoggedIn":(\d+)/) || [])[1] === '1';
  const liuId = (html.match(/liuIdOrNull\s*=\s*(\d+)/) || [])[1];
  // PH escapa &amp; en los atributos HTML; lo deshacemos para la URL real.
  return { subscribeUrl: subscribeUrl ? subscribeUrl.replace(/&amp;/g, '&') : null, subscribed, loggedIn, liuId };
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
  if (!page.subscribeUrl) return json({ error: 'Este video no tiene un canal suscribible' }, 422);

  // Intención del cliente; por defecto, lo opuesto al estado actual.
  const want = typeof body.subscribe === 'boolean' ? body.subscribe : !page.subscribed;

  // Si ya estamos en el estado deseado, no hacemos nada (idempotente): evita que
  // un click fuera de sincronía invierta lo que el usuario quería.
  if (want === page.subscribed) return json({ success: true, subscribed: page.subscribed, noop: true });

  // `data-subscribe-url` SIEMPRE apunta a subscribe_add_json (con id+token). El
  // mismo token sirve para quitar: basta cambiar add_json→remove_json.
  const targetUrl = want
    ? page.subscribeUrl
    : page.subscribeUrl.replace('subscribe_add_json', 'subscribe_remove_json');

  try {
    const res = await fetch(`${BASE_URL}${targetUrl}`, {
      method: 'POST',
      headers: {
        accept: '*/*',
        'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
        'user-agent': UA,
        origin: BASE_URL,
        referer: pageUrl,
        'x-requested-with': 'XMLHttpRequest',
        ...(page.liuId ? { __m: String(page.liuId) } : {}),
        cookie,
      },
    });

    const data = await res.json().catch(() => ({}));
    const success = data.success === 'PASS' || data.success === 'true' || data.success === true;
    const subscribed = success ? want : page.subscribed;
    return json({ success, subscribed, message: data.message || '' });
  } catch (e) {
    return json({ error: 'Error al alternar suscripción: ' + e.message }, 502);
  }
};
