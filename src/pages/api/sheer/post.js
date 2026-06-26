// API JSON de un post de Sheer. La consume el reproductor (/sheer/play) cuando
// se abre desde la página de suscripciones: ahí los posts sólo traen vista
// previa, así que pedimos las fuentes reproducibles del post bajo demanda.
//
//   GET ?postId=123&url=/alias/post/123 → { postId, title, poster, sources, ... }
import { scrapeSheerPost } from '../../../lib/sheer/scraper.js';

export const prerender = false;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

export const GET = async (context) => {
  const env = context.locals?.runtime?.env;
  const params = context.url.searchParams;
  const postId = params.get('postId') || '';
  const url = params.get('url') || '';

  if (!url) return json({ ok: false, error: 'Falta el parámetro url del post.' }, 400);

  try {
    const video = await scrapeSheerPost({ postId, url, env });
    return json({ ok: true, video });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
};
