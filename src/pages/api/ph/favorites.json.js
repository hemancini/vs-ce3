// El JSON de favoritos generado por el scraper (scripts/ph/scrape.mjs --source
// favorites) se empaqueta en build-time y se sirve como API en
// /api/ph/favorites.json.
// (Cloudflare Workers no tiene filesystem, por eso no se lee con node:fs en runtime.)
import favorites from './77b53b8/favorites.json';

export const GET = async () => {
  return new Response(JSON.stringify(favorites), {
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'access-control-allow-origin': '*',
    },
  });
};
