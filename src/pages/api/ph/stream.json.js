// Endpoint on-demand: dado el pageUrl (o vkey) de un video de Pornhub, descarga
// la página con fetch() (cookies + cabeceras de navegador) y extrae las URLs de
// stream FRESCAS de los flashvars embebidos en el HTML.
//
// Por qué fetch y no un navegador: el HTML server-side YA contiene
// `var flashvars_… = { … mediaDefinitions … }`. Solo hace falta enviar las
// cookies correctas (incluidas las de age-gate, sin ellas Pornhub sirve un stub)
// y cabeceras tipo navegador para no recibir el bloqueo de bots. fetch() corre
// igual en `astro dev` (Node) y en Cloudflare Workers, así que funciona en ambos
// sin Playwright ni Browser Rendering.
//
// Si la extracción falla, caemos a los streams guardados en videos.json (pueden
// estar caducados, pero evita el 500).

import storedVideos from './model/nico-grey/videos.json';
import rawCookiesFallback from '../../../../scripts/ph/cookies.json';

export const prerender = false;

const BASE_URL = 'https://es.pornhub.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Cookies para saltar la interstitial de edad/consentimiento. Sin estas, Pornhub
// sirve una página stub que no contiene los mediaDefinitions.
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
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent': UA,
};

function storedStreamsFor(vkey, pageUrl) {
  const v = storedVideos.find(
    (x) => (vkey && x.vkey === vkey) || (pageUrl && x.pageUrl === pageUrl),
  );
  return v?.streams ?? [];
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });

// Extras de los flashvars que alimentan los controles personalizados del player:
// los sprites de scrubbing (vista previa), la gráfica de popularidad (hotspots),
// los marcadores de acción y la duración. Todo opcional: si falta, el player
// degrada con elegancia (sin preview/hotspots/tags).
function parseExtras(fv) {
  const thumbs =
    fv.thumbs && typeof fv.thumbs === 'object'
      ? {
          samplingFrequency: Number(fv.thumbs.samplingFrequency) || 0,
          urlPattern: fv.thumbs.urlPattern || '',
          spritePatterns: Array.isArray(fv.thumbs.spritePatterns) ? fv.thumbs.spritePatterns : [],
        }
      : null;

  const hotspots = Array.isArray(fv.hotspots) ? fv.hotspots.map(Number).filter(Number.isFinite) : [];

  // "Fingering:65,Missionary:428" → [{ label: 'Fingering', time: 65 }, …]
  const actionTags =
    typeof fv.actionTags === 'string' && fv.actionTags
      ? fv.actionTags
          .split(',')
          .map((p) => {
            const i = p.lastIndexOf(':');
            return { label: p.slice(0, i).trim(), time: Number(p.slice(i + 1)) };
          })
          .filter((t) => t.label && Number.isFinite(t.time))
      : [];

  return {
    duration: Number(fv.video_duration) || 0,
    thumbs: thumbs && (thumbs.spritePatterns.length || thumbs.urlPattern) ? thumbs : null,
    hotspots,
    actionTags,
  };
}

// Estado de favoritos del usuario logueado, leído del bloque GS_LIKE_FAV que PH
// embebe en la página. Sirve para pintar el corazón con el estado correcto sin
// una petición extra. Si no hay sesión (loggedIn=0) el botón se oculta.
function parseFavorite(html) {
  const m = html.match(/GS_LIKE_FAV\s*=\s*\{([\s\S]*?)\}\s*;/);
  const scope = m ? m[1] : html;
  const id = (scope.match(/"itemId(?:Num)?":(\d+)/) || html.match(/"video_id":(\d+)/) || [])[1];
  if (!id) return null;
  const isFav = (scope.match(/"isFavourite":(\d+)/) || [])[1];
  const loggedIn = (scope.match(/"loggedIn":(\d+)/) || html.match(/"isLoggedIn":(\d+)/) || [])[1];
  return { id: Number(id), isFavourite: isFav === '1', loggedIn: loggedIn === '1' };
}

// Estado de suscripción al canal/modelo del uploader, leído del botón de
// suscripción que PH embebe (`data-subscribe-url` + `data-subscribed`). null si
// el video no tiene un uploader suscribible.
function parseSubscribe(html) {
  const url = (html.match(/data-subscribe-url="([^"]+)"/) || [])[1];
  if (!url) return null;
  const subscribed = (html.match(/data-subscribed="(\d)"/) || [])[1] === '1';
  return { subscribed };
}

function parseStreams(mediaDefs) {
  return mediaDefs
    .filter((d) => typeof d.videoUrl === 'string' && d.videoUrl.length > 0)
    .sort((a, b) => parseInt(b.quality, 10) - parseInt(a.quality, 10))
    .map(({ quality, format, videoUrl, width, height, defaultQuality }) => ({
      quality: String(quality),
      format,
      width,
      height,
      default: !!defaultQuality,
      videoUrl: videoUrl.replace(/&amp;/g, '&'),
    }));
}

export const GET = async ({ url, locals }) => {
  const env = locals?.runtime?.env;
  const params = url.searchParams;
  const vkey = params.get('vkey');
  let pageUrl = params.get('url');
  if (!pageUrl && vkey) pageUrl = `${BASE_URL}/view_video.php?viewkey=${vkey}`;
  if (!pageUrl) return json({ error: 'Falta el parámetro ?vkey= o ?url=' }, 400);

  const stored = () => storedStreamsFor(vkey, pageUrl);

  try {
    const res = await fetch(pageUrl, {
      headers: { ...BROWSER_HEADERS, cookie: await cookieHeader(env) },
      redirect: 'follow',
    });
    const html = await res.text();

    const m = html.match(/var\s+flashvars_\d+\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (!m) {
      const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
      return json({
        streams: stored(),
        source: 'stored',
        error: 'No se encontraron flashvars',
        diag: { status: res.status, htmlLen: html.length, title },
      });
    }

    let fv;
    try {
      fv = JSON.parse(m[1]);
    } catch (e) {
      return json({ streams: stored(), source: 'stored', error: 'flashvars no parseable: ' + e.message });
    }

    const streams = parseStreams(fv.mediaDefinitions ?? []);
    if (!streams.length) {
      return json({ streams: stored(), source: 'stored', error: 'mediaDefinitions sin videoUrl' });
    }
    return json({
      streams,
      source: 'fresh',
      ...parseExtras(fv),
      favorite: parseFavorite(html),
      subscribe: parseSubscribe(html),
    });
  } catch (err) {
    return json({ streams: stored(), source: 'stored', error: err.message });
  }
};
