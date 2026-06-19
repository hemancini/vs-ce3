// El JSON generado por el scraper se empaqueta en build-time y se sirve como API.
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
