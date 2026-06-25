// Endpoint on-demand: dado el vkey (o pageUrl) de un video de Pornhub, descarga
// la página y extrae sus metadatos (vistas, fecha, likes, uploader, categorías)
// junto con los listados de videos relacionados y recomendados. Lo consume la
// página de reproducción /ph/play para mostrar la ficha y las grillas inferiores.
//
// La resolución del stream reproducible sigue en /api/ph/stream.json (se refresca
// aparte porque las URLs de stream caducan); este endpoint es para la ficha y se
// pide una sola vez por carga.

import { scrapeVideoPage } from '../../../lib/ph/scraper.js';

export const prerender = false;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });

export const GET = async ({ url, locals }) => {
  const env = locals?.runtime?.env;
  const vkey = url.searchParams.get('vkey');
  const pageUrl = url.searchParams.get('url');
  if (!vkey && !pageUrl) return json({ error: 'Falta el parámetro ?vkey= o ?url=' }, 400);

  try {
    const data = await scrapeVideoPage({ vkey, pageUrl, env });
    return json(data);
  } catch (err) {
    return json({ error: err.message, meta: null, related: [], recommended: [] });
  }
};
