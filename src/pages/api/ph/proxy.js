// Proxy de streaming para HLS/MP4 de Pornhub.
//
// Por qué: las URLs de stream del CDN (hv-h/ev-h.phncdn.com) a veces NO incluyen
// cabeceras CORS, así que hls.js no puede cargar el manifiesto/segmentos desde el
// navegador (falla con 412 / "No 'Access-Control-Allow-Origin'"). Proxeando todo
// a través de nuestro propio dev server (mismo origen) el CORS desaparece.
//
// Para HLS reescribimos el .m3u8: cada playlist/segmento referenciado se reenruta
// de nuevo por este proxy para que TODA la cadena pase por aquí.
//
// Solo funciona en `astro dev` (Node con fetch). En Cloudflare Workers no aplica.

export const prerender = false;

const ALLOWED_HOST = 'phncdn.com';
const SELF = '/api/ph/proxy';

const PASS_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  referer: 'https://es.pornhub.com/',
  origin: 'https://es.pornhub.com',
};

const wrap = (absUrl) => `${SELF}?url=${encodeURIComponent(absUrl)}`;

// El CDN de PH a veces responde 200 con cuerpo vacío para el manifiesto (.m3u8),
// un fallo transitorio externo. Reintentamos la descarga del manifiesto hasta 3
// veces antes de rendirnos para que el reproductor no falle a la primera.
const MANIFEST_FETCH_ATTEMPTS = 3;
const RETRY_BASE_MS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reescribe un manifiesto m3u8 para que todas las URIs pasen por el proxy.
function rewriteManifest(text, baseUrl) {
  const resolve = (u) => new URL(u, baseUrl).toString();
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        // Tags con URI="..." (#EXT-X-KEY, #EXT-X-MEDIA, #EXT-X-MAP, etc.)
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${wrap(resolve(uri))}"`);
      }
      // Línea de playlist/segmento.
      return wrap(resolve(trimmed));
    })
    .join('\n');
}

export const GET = async ({ url, request }) => {
  const target = url.searchParams.get('url');
  if (!target) {
    return new Response(JSON.stringify({ error: 'Falta ?url=' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return new Response('URL inválida', { status: 400 });
  }
  if (!parsed.hostname.endsWith(ALLOWED_HOST)) {
    return new Response('Host no permitido', { status: 403 });
  }

  // Reenviar Range para que el seek de vídeo funcione.
  const fwdHeaders = { ...PASS_HEADERS };
  const range = request.headers.get('range');
  if (range) fwdHeaders['range'] = range;

  // ¿Esperamos un manifiesto? Lo sabemos por la extensión de la URL pedida; así
  // podemos reintentar la descarga ante un cuerpo vacío del CDN (fallo externo).
  const isManifestUrl = /\.m3u8(\?|$)/.test(parsed.pathname + parsed.search);

  const baseHeaders = {
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  };

  // ── Manifiestos (.m3u8): descargar el texto reintentando si llega vacío ──
  if (isManifestUrl) {
    let lastErr = '';
    for (let attempt = 1; attempt <= MANIFEST_FETCH_ATTEMPTS; attempt++) {
      let upstream;
      try {
        upstream = await fetch(target, { headers: fwdHeaders, redirect: 'follow' });
      } catch (err) {
        lastErr = 'Error upstream: ' + err.message;
        if (attempt < MANIFEST_FETCH_ATTEMPTS) { await sleep(RETRY_BASE_MS * attempt); continue; }
        return new Response(lastErr, { status: 502 });
      }

      const body = await upstream.text();
      // Cuerpo vacío (o solo espacios) = fallo transitorio del CDN: reintentamos.
      if (!body.trim()) {
        lastErr = `Manifiesto vacío del CDN (intento ${attempt}/${MANIFEST_FETCH_ATTEMPTS})`;
        if (attempt < MANIFEST_FETCH_ATTEMPTS) { await sleep(RETRY_BASE_MS * attempt); continue; }
        return new Response(lastErr, { status: 502 });
      }

      // upstream.url refleja la URL final tras redirecciones: base correcta para resolver.
      const rewritten = rewriteManifest(body, upstream.url || target);
      return new Response(rewritten, {
        status: 200,
        headers: { ...baseHeaders, 'content-type': 'application/vnd.apple.mpegurl' },
      });
    }
  }

  // ── Segmentos / mp4: una sola descarga, passthrough binario ──
  let upstream;
  try {
    upstream = await fetch(target, { headers: fwdHeaders, redirect: 'follow' });
  } catch (err) {
    return new Response('Error upstream: ' + err.message, { status: 502 });
  }

  const headers = { ...baseHeaders };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  return new Response(upstream.body, { status: upstream.status, headers });
};
