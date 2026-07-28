// Miniaturas del timeline de un post de Sheer. El WebVTT vive en
// www.sheer.com, que no manda cabeceras CORS, así que el navegador no puede
// pedirlo directo: esta ruta lo trae desde el server y lo devuelve ya parseado
// en forma compacta para el reproductor.
//
//   GET ?url=https://www.sheer.com/seek-preview/2445904?media_id=1131280218
//     → { ok, preview: { sprites, tileW, tileH, cues: [[t, spriteIdx, x, y], …] } }
import { fetchSeekPreview } from '../../../lib/sheer/scraper.js';

export const prerender = false;

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const GET = async (context) => {
  const env = context.locals?.runtime?.env;
  const url = context.url.searchParams.get('url') || '';

  if (!url) return json({ ok: false, error: 'Falta el parámetro url de la pista.' }, 400);

  try {
    const preview = await fetchSeekPreview({ url, env });
    // Los sprites llevan token de expiración lejano; cachear una hora evita
    // repetir el fetch en cada apertura del player.
    return json({ ok: true, preview }, 200, { 'cache-control': 'public, max-age=3600' });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
};
