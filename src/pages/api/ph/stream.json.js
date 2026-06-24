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
import rawCookies from '../../../../scripts/ph/cookies.json';

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

function cookieHeader() {
  const pairs = rawCookies.map((c) => `${c.name}=${c.value}`);
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

export const GET = async ({ url }) => {
  const params = url.searchParams;
  const vkey = params.get('vkey');
  let pageUrl = params.get('url');
  if (!pageUrl && vkey) pageUrl = `${BASE_URL}/view_video.php?viewkey=${vkey}`;
  if (!pageUrl) return json({ error: 'Falta el parámetro ?vkey= o ?url=' }, 400);

  const stored = () => storedStreamsFor(vkey, pageUrl);

  try {
    const res = await fetch(pageUrl, {
      headers: { ...BROWSER_HEADERS, cookie: cookieHeader() },
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

    let mediaDefs;
    try {
      mediaDefs = JSON.parse(m[1]).mediaDefinitions ?? [];
    } catch (e) {
      return json({ streams: stored(), source: 'stored', error: 'flashvars no parseable: ' + e.message });
    }

    const streams = parseStreams(mediaDefs);
    if (!streams.length) {
      return json({ streams: stored(), source: 'stored', error: 'mediaDefinitions sin videoUrl' });
    }
    return json({ streams, source: 'fresh' });
  } catch (err) {
    return json({ streams: stored(), source: 'stored', error: err.message });
  }
};
