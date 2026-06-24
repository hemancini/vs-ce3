// El JSON generado por el scraper (scripts/ph/scrape.mjs) se empaqueta en
// build-time y se sirve como API en /api/ph/videos.json.
// (Cloudflare Workers no tiene filesystem, por eso no se lee con node:fs en runtime.)
import videos from './videos.json';

export const GET = async () => {
  return new Response(JSON.stringify(videos), {
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'access-control-allow-origin': '*',
    },
  });
};
