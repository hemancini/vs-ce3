// src/lib/sheer/scraper.js
//
// Librería de scraping de Sheer usada por la app SSR. El HTML server-side de
// Sheer ya trae 10 posts por página (?page=N) con su <video><source> .mp4
// inline, así que basta con fetch() + node-html-parser enviando la cookie de
// sesión — no hace falta navegador ni hover.
//
// Diseñada para SSR on-demand: scrapeSheer() recorre N páginas (1 fetch por
// página, con un pool de concurrencia) y devuelve los videos deduplicados +
// el total de páginas detectado.
//
// Portabilidad: el fetch nativo de Node (undici) revienta con
// HeadersOverflowError porque Sheer manda muchísimas cabeceras Set-Cookie. Por
// eso fetchHtml hace fallback a node:https con maxHeaderSize ampliado cuando
// detecta ese error (solo ocurre en `astro dev`/Node; en Cloudflare Workers el
// fetch nativo maneja bien las cabeceras grandes).

import { parse } from 'node-html-parser';
import { decryptJSON, encryptString, encryptBytes, decryptBytes } from './crypto.js';

const BASE_URL = 'https://www.sheer.com';
const DEFAULT_ALIAS = 'TheGrey';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
  'user-agent': UA,
};

const normStr = (s) => (s == null ? '' : String(s).replace(/&amp;/g, '&'));
const isEmpty = (s) => s == null || String(s).trim() === '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Cookies ──────────────────────────────────────────────────────────────────
// Las cookies de la cuenta activa viven en KV ('sheer:cookies'), que las escribe
// /api/sheer/auth al guardar/elegir una cuenta. Devuelve la cabecera "k=v; …".
function cookiesToHeader(cookies) {
  return (cookies || [])
    .filter((c) => c && c.name)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

async function resolveCookieHeader(env) {
  try {
    const raw = await env?.VS_C3_KV?.get('sheer:cookies');
    // Las cookies se guardan cifradas (AES-GCM); decryptJSON tolera texto plano.
    if (raw) return cookiesToHeader(await decryptJSON(raw, resolveSecret(env)));
  } catch {}
  return '';
}

// ── Fetch con fallback para cabeceras gigantes ───────────────────────────────
function isHeaderOverflow(err) {
  const code = err?.code || err?.cause?.code;
  return (
    code === 'UND_ERR_HEADERS_OVERFLOW' ||
    /headers? overflow/i.test(err?.message || '') ||
    /headers? overflow/i.test(err?.cause?.message || '')
  );
}

// node:https con maxHeaderSize ampliado (solo Node/dev).
async function fetchHtmlNode(url, cookieHeader) {
  const https = (await import('node:https')).default;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        maxHeaderSize: 256 * 1024,
        headers: { ...BROWSER_HEADERS, cookie: cookieHeader },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { data += d; });
        res.on('end', () => resolve(data));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// Una vez que el fetch nativo revienta por overflow (Node/dev), recordamos que
// hay que usar node:https directamente y no malgastamos un intento nativo por
// cada página. En Workers el fetch nativo no falla, así que esto nunca se activa.
let preferNodeHttps = false;

async function fetchHtml(url, cookieHeader) {
  if (preferNodeHttps) return fetchHtmlNode(url, cookieHeader);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { ...BROWSER_HEADERS, cookie: cookieHeader },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (isHeaderOverflow(err)) {
      preferNodeHttps = true;
      return fetchHtmlNode(url, cookieHeader);
    }
    throw err;
  }
}

// ── Parseo de una página SSR ─────────────────────────────────────────────────
function parsePage(html) {
  const root = parse(html);
  return root.querySelectorAll('article.post[data-post-id]').map((post) => {
    const video = post.querySelector('video.js-video-source, video');
    const sources = video
      ? video
          .querySelectorAll('source')
          .map((s) => ({
            src: normStr(s.getAttribute('src')),
            size: s.getAttribute('size'),
            bitrate: s.getAttribute('bitrate'),
          }))
          .filter((s) => !isEmpty(s.src))
      : [];

    const postId = post.getAttribute('data-post-id') || '';
    const videoId = video ? video.getAttribute('data-video-id') || '' : '';
    const contentId = video ? video.getAttribute('data-content-id') || '' : '';
    const alias = video ? video.getAttribute('data-alias') || '' : '';

    let title = post.querySelector('[data-post-title]')?.getAttribute('data-post-title') || '';
    if (!title) {
      title = (post.querySelector('.post-title, .title, .video-title, h3, h4, .post-text')?.text || '').trim();
    }

    // poster: en SSR vive en data-poster del <video>; fallback a la imagen.
    let poster = normStr(video?.getAttribute('data-poster') || video?.getAttribute('poster') || '');
    if (!poster) {
      const imgEl = post.querySelector('img.video-poster__img, img.video-poster__background');
      if (imgEl) poster = normStr(imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '');
    }
    if (!poster) {
      const bgEl = post.querySelector('.video-poster__background');
      const m = (bgEl?.getAttribute('style') || '').match(/url\(['"]?([^'"]+)['"]?\)/);
      if (m) poster = normStr(m[1]);
    }

    const models = post
      .querySelectorAll('.post__featuring-models__list-item')
      .map((el) => ({ id: el.getAttribute('data-model-id') || '', name: el.text.trim() }))
      .filter((mdl) => mdl.name);

    const tags = post
      .querySelectorAll('.post-tags__item')
      .map((li) => {
        const link = li.querySelector('.post-tags__link');
        const tagAlias = li.getAttribute('data-tag-alias') || '';
        return {
          id: li.getAttribute('data-tag-id') || '',
          alias: tagAlias,
          name: link ? link.text.trim() : tagAlias,
        };
      })
      .filter((t) => t.alias || t.name);

    let views = null;
    const viewsEl = post.querySelector('.post__counter--views strong');
    if (viewsEl) {
      const raw = (viewsEl.text || '').replace(/[^\d]/g, '');
      if (raw) views = parseInt(raw, 10);
    }

    const date = (post.querySelector('.post__date-text, .post__date')?.text || '').trim();
    const duration = (post.querySelector('.runtime-tag span, .runtime-tag')?.text || '').trim();

    return {
      postId,
      videoId,
      contentId,
      alias,
      title: title || `Video ${videoId || postId}`,
      poster,
      models,
      tags,
      views,
      date,
      duration,
      sources,
    };
  });
}

// total_pages viene en el JSON de APP_CONFIG:
// ...,"pagination":{"page":"1","total_pages":40}
function detectTotalPages(html) {
  const m = html.match(/"total_pages"\s*:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : 1;
}

function buildPageUrl(alias, page) {
  const u = new URL(`${BASE_URL}/${alias}`);
  u.searchParams.set('page', String(page));
  return u.toString();
}

// ── Pool de concurrencia ─────────────────────────────────────────────────────
async function runPool(items, concurrency, worker) {
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, next));
}

/**
 * Scrapea N páginas del catálogo de un creador de Sheer y devuelve los videos
 * (deduplicados por postId/videoId) más el total de páginas detectado.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.alias]        creador (default: TheGrey)
 * @param {number}  [opts.maxPages]     páginas a recorrer (default 1)
 * @param {number}  [opts.concurrency]  fetches en paralelo (default 4)
 * @param {any}     [opts.env]          runtime env (para VS_C3_KV)
 * @returns {Promise<{ videos: any[], totalPages: number, alias: string }>}
 */
export async function scrapeSheer({ alias = DEFAULT_ALIAS, maxPages = 1, concurrency = 4, env } = {}) {
  const cookieHeader = await resolveCookieHeader(env);
  if (!cookieHeader) {
    throw new Error('No hay cookies de Sheer en VS_C3_KV[sheer:cookies]. Inicia sesión o elige una cuenta.');
  }

  const firstHtml = await fetchHtml(buildPageUrl(alias, 1), cookieHeader);
  if (/name=["']?password|type=["']?password/i.test(firstHtml) && !firstHtml.includes('data-post-id')) {
    throw new Error('Sesión no válida o página de login — las cookies pueden haber expirado.');
  }

  const totalPages = detectTotalPages(firstHtml);
  const pages = Math.max(1, Math.min(maxPages || 1, totalPages));

  const all = parsePage(firstHtml);

  if (pages > 1) {
    const rest = Array.from({ length: pages - 1 }, (_, i) => i + 2);
    await runPool(rest, concurrency, async (p) => {
      try {
        const html = await fetchHtml(buildPageUrl(alias, p), cookieHeader);
        all.push(...parsePage(html));
      } catch {
        // Página fallida: la saltamos sin abortar todo el scrape.
      }
    });
  }

  // Dedup por postId (fallback a videoId). Cada página trae posts distintos,
  // así que basta una pasada simple.
  const seen = new Set();
  const videos = all.filter((v) => {
    if (!v.sources || v.sources.length === 0) return false;
    const key = v.postId || v.videoId;
    if (key && seen.has(key)) return false;
    if (key) seen.add(key);
    return true;
  });

  return { videos, totalPages, alias };
}

/**
 * Scrapea UNA sola página del catálogo. Pensado para el scroll infinito: el
 * cliente pide ?page=N y recibe solo los videos de esa página.
 *
 * @param {object} [opts]
 * @param {string} [opts.alias]  creador (default: TheGrey)
 * @param {number} [opts.page]   número de página (default 1)
 * @param {any}    [opts.env]    runtime env (para VS_C3_KV)
 * @returns {Promise<{ videos: any[], totalPages: number, page: number, alias: string }>}
 */
export async function scrapeSheerPage({ alias = DEFAULT_ALIAS, page = 1, env } = {}) {
  const cookieHeader = await resolveCookieHeader(env);
  if (!cookieHeader) {
    throw new Error('No hay cookies de Sheer en VS_C3_KV[sheer:cookies]. Inicia sesión o elige una cuenta.');
  }

  const html = await fetchHtml(buildPageUrl(alias, page), cookieHeader);
  if (page === 1 && /name=["']?password|type=["']?password/i.test(html) && !html.includes('data-post-id')) {
    throw new Error('Sesión no válida o página de login — las cookies pueden haber expirado.');
  }

  const totalPages = detectTotalPages(html);
  const seen = new Set();
  const videos = parsePage(html).filter((v) => {
    if (!v.sources || v.sources.length === 0) return false;
    const key = v.postId || v.videoId;
    if (key && seen.has(key)) return false;
    if (key) seen.add(key);
    return true;
  });

  return { videos, totalPages, page, alias };
}

// ── Suscripciones ────────────────────────────────────────────────────────────
// Parsea la página /subscriptions (SSR): una tarjeta por creador suscrito, cada
// una con su cabecera (nombre, alias, avatar, estado de suscripción) y una lista
// de posts de vista previa (poster + clip .mp4 al hover + enlace al post).
function parseSubscriptions(html) {
  const root = parse(html);
  return root.querySelectorAll('.js-subscription-account').map((acc) => {
    const header = acc.querySelector('.subscription-accounts__header');
    const alias = header?.getAttribute('data-dialog-alias') || '';
    const name = (acc.querySelector('.name')?.text || '').trim();
    const headshot = normStr(acc.querySelector('.avatar img')?.getAttribute('src') || '');

    // Botón de suscripción: estado ("Suscrito hasta …") y poster de portada.
    const subBtn = acc.querySelector('.js-subscribe-button');
    const status = (acc.querySelector('.btn-loading__text')?.text || '').trim();
    const poster = normStr(subBtn?.getAttribute('data-poster') || '');

    const posts = acc
      .querySelectorAll('.js-preview-post')
      .map((post) => {
        const link = post.querySelector('.js-post-link, a');
        const img = post.querySelector('.post__image img');
        return {
          postId: link?.getAttribute('data-post-id') || '',
          url: normStr(link?.getAttribute('href') || ''),
          title: (post.querySelector('.post__title')?.text || '').trim(),
          // data-lazy trae el poster real; src suele ser un placeholder bloqueado.
          poster: normStr(img?.getAttribute('data-lazy') || img?.getAttribute('src') || ''),
          preview: normStr(post.getAttribute('data-preview') || ''),
        };
      })
      .filter((p) => p.postId || p.title);

    return { alias, name, headshot, poster, status, posts };
  });
}

/**
 * Scrapea la página de suscripciones activas del usuario (/subscriptions).
 * Devuelve un creador por suscripción con sus posts de vista previa.
 *
 * @param {object} [opts]
 * @param {any}    [opts.env]  runtime env (para VS_C3_KV)
 * @returns {Promise<{ accounts: any[] }>}
 */
export async function scrapeSheerSubscriptions({ env } = {}) {
  const cookieHeader = await resolveCookieHeader(env);
  if (!cookieHeader) {
    throw new Error('No hay cookies de Sheer en VS_C3_KV[sheer:cookies]. Inicia sesión o elige una cuenta.');
  }

  const html = await fetchHtml(`${BASE_URL}/subscriptions`, cookieHeader);
  if (/name=["']?password|type=["']?password/i.test(html) && !html.includes('js-subscription-account')) {
    throw new Error('Sesión no válida o página de login — las cookies pueden haber expirado.');
  }

  return { accounts: parseSubscriptions(html) };
}

/**
 * Scrapea UN solo post de Sheer y devuelve sus datos de reproducción (incluidas
 * las fuentes .mp4). La página de suscripciones sólo trae clips de vista previa
 * sin `sources`, así que al abrir el reproductor desde ahí necesitamos visitar
 * la página real del post para obtener las fuentes reproducibles.
 *
 * @param {object} [opts]
 * @param {string} [opts.postId]  id del post (para seleccionar el correcto)
 * @param {string} [opts.url]     enlace al post (absoluto o relativo a BASE_URL)
 * @param {any}    [opts.env]     runtime env (para VS_C3_KV)
 * @returns {Promise<object>} el video con sus `sources`
 */
export async function scrapeSheerPost({ postId, url, env } = {}) {
  const cookieHeader = await resolveCookieHeader(env);
  if (!cookieHeader) {
    throw new Error('No hay cookies de Sheer en VS_C3_KV[sheer:cookies]. Inicia sesión o elige una cuenta.');
  }
  if (!url) throw new Error('Falta la URL del post.');

  const target = /^https?:\/\//i.test(url) ? url : `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
  const html = await fetchHtml(target, cookieHeader);
  if (/name=["']?password|type=["']?password/i.test(html) && !html.includes('data-post-id')) {
    throw new Error('Sesión no válida o página de login — las cookies pueden haber expirado.');
  }

  const posts = parsePage(html);
  const wanted = postId ? String(postId) : '';
  const video = posts.find((v) => v.postId === wanted) || posts[0];
  if (!video || !video.sources || video.sources.length === 0) {
    throw new Error(`No se encontraron fuentes reproducibles para el post ${postId || ''}.`);
  }
  return video;
}

// ── Membresías (feed) ────────────────────────────────────────────────────────
// La página /memberships (requiere cookie de sesión: sin ella muestra el
// "Discover Memberships" público) agrega en un único feed los videos full de
// TODOS los creadores a los que estás suscrito. Su markup es idéntico al del
// catálogo por creador (article.post[data-post-id] con <video><source>), así que
// reutilizamos parsePage()/detectTotalPages(); cada post trae su propio
// data-alias. Soporta paginación ?page=N como el catálogo.
const MEMBERSHIP_PATH = 'memberships';

function buildMembershipUrl(page) {
  const u = new URL(`${BASE_URL}/${MEMBERSHIP_PATH}`);
  u.searchParams.set('page', String(page));
  return u.toString();
}

// Dedup compartido: descarta posts sin fuentes y duplicados por postId/videoId.
function dedupVideos(all) {
  const seen = new Set();
  return all.filter((v) => {
    if (!v.sources || v.sources.length === 0) return false;
    const key = v.postId || v.videoId;
    if (key && seen.has(key)) return false;
    if (key) seen.add(key);
    return true;
  });
}

function isLoginHtml(html) {
  return /name=["']?password|type=["']?password/i.test(html) && !html.includes('data-post-id');
}

/**
 * Scrapea N páginas del feed de membresías (/memberships) y devuelve los
 * videos (deduplicados) más el total de páginas detectado.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxPages]     páginas a recorrer (default 1)
 * @param {number} [opts.concurrency]  fetches en paralelo (default 4)
 * @param {any}    [opts.env]          runtime env (para VS_C3_KV)
 * @returns {Promise<{ videos: any[], totalPages: number }>}
 */
export async function scrapeSheerMemberships({ maxPages = 1, concurrency = 4, env } = {}) {
  const cookieHeader = await resolveCookieHeader(env);
  if (!cookieHeader) {
    throw new Error('No hay cookies de Sheer en VS_C3_KV[sheer:cookies]. Inicia sesión o elige una cuenta.');
  }

  const firstHtml = await fetchHtml(buildMembershipUrl(1), cookieHeader);
  if (isLoginHtml(firstHtml)) {
    throw new Error('Sesión no válida o página de login — las cookies pueden haber expirado.');
  }

  const totalPages = detectTotalPages(firstHtml);
  const pages = Math.max(1, Math.min(maxPages || 1, totalPages));
  const all = parsePage(firstHtml);

  if (pages > 1) {
    const rest = Array.from({ length: pages - 1 }, (_, i) => i + 2);
    await runPool(rest, concurrency, async (p) => {
      try {
        all.push(...parsePage(await fetchHtml(buildMembershipUrl(p), cookieHeader)));
      } catch {
        // Página fallida: la saltamos sin abortar todo el scrape.
      }
    });
  }

  return { videos: dedupVideos(all), totalPages };
}

/**
 * Scrapea UNA sola página del feed de membresías. Pensado para el scroll
 * infinito: el cliente pide ?page=N y recibe solo los videos de esa página.
 *
 * @param {object} [opts]
 * @param {number} [opts.page]  número de página (default 1)
 * @param {any}    [opts.env]   runtime env (para VS_C3_KV)
 * @returns {Promise<{ videos: any[], totalPages: number, page: number }>}
 */
export async function scrapeSheerMembershipsPage({ page = 1, env } = {}) {
  const cookieHeader = await resolveCookieHeader(env);
  if (!cookieHeader) {
    throw new Error('No hay cookies de Sheer en VS_C3_KV[sheer:cookies]. Inicia sesión o elige una cuenta.');
  }

  const html = await fetchHtml(buildMembershipUrl(page), cookieHeader);
  if (page === 1 && isLoginHtml(html)) {
    throw new Error('Sesión no válida o página de login — las cookies pueden haber expirado.');
  }

  return { videos: dedupVideos(parsePage(html)), totalPages: detectTotalPages(html), page };
}

// ── Biblioteca completa (suscripciones → videos de cada creador) ─────────────
// Recorre /subscriptions para obtener los creadores suscritos y luego scrapea el
// catálogo completo de cada uno (todas sus páginas), agregando un único objeto
// con todos los videos. Pensado para construir un índice que se persiste en KV
// (`sheer:library`) y poder consumirlo sin volver a scrapear.
const KV_LIBRARY = 'sheer:library';

// Scrapea TODAS las páginas del catálogo de un creador con una cookie ya
// resuelta (evita releer KV por cada creador). maxPages=0 → todas las detectadas.
async function scrapeCreatorAll({ alias, maxPages = 0, concurrency = 4, cookieHeader }) {
  const firstHtml = await fetchHtml(buildPageUrl(alias, 1), cookieHeader);
  if (isLoginHtml(firstHtml)) {
    throw new Error('Sesión no válida o página de login — las cookies pueden haber expirado.');
  }

  const totalPages = detectTotalPages(firstHtml);
  const cap = maxPages > 0 ? Math.min(maxPages, totalPages) : totalPages;
  const all = parsePage(firstHtml);

  if (cap > 1) {
    const rest = Array.from({ length: cap - 1 }, (_, i) => i + 2);
    await runPool(rest, concurrency, async (p) => {
      try {
        all.push(...parsePage(await fetchHtml(buildPageUrl(alias, p), cookieHeader)));
      } catch {
        // Página fallida: la saltamos sin abortar el creador.
      }
    });
  }

  return { videos: dedupVideos(all), totalPages };
}

/**
 * Construye la biblioteca completa: lee las suscripciones activas y, para cada
 * creador, scrapea su catálogo entero. Devuelve un objeto agregado listo para
 * persistir en KV.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxPagesPerCreator]  páginas por creador (0 = todas; default 0)
 * @param {number} [opts.pageConcurrency]     fetches de páginas en paralelo por creador (default 4)
 * @param {number} [opts.creatorConcurrency]  creadores procesados en paralelo (default 2)
 * @param {any}    [opts.env]                 runtime env (para VS_C3_KV)
 * @returns {Promise<{ generatedAt:number, totalCreators:number, totalVideos:number, creators:any[] }>}
 */
export async function scrapeSheerLibrary({
  maxPagesPerCreator = 0,
  pageConcurrency = 4,
  creatorConcurrency = 2,
  env,
} = {}) {
  const cookieHeader = await resolveCookieHeader(env);
  if (!cookieHeader) {
    throw new Error('No hay cookies de Sheer en VS_C3_KV[sheer:cookies]. Inicia sesión o elige una cuenta.');
  }

  const subsHtml = await fetchHtml(`${BASE_URL}/subscriptions`, cookieHeader);
  if (/name=["']?password|type=["']?password/i.test(subsHtml) && !subsHtml.includes('js-subscription-account')) {
    throw new Error('Sesión no válida o página de login — las cookies pueden haber expirado.');
  }

  const subs = parseSubscriptions(subsHtml).filter((s) => s.alias);
  const creators = [];

  await runPool(subs, creatorConcurrency, async (sub) => {
    const base = { alias: sub.alias, name: sub.name || sub.alias, headshot: sub.headshot };
    try {
      const { videos, totalPages } = await scrapeCreatorAll({
        alias: sub.alias,
        maxPages: maxPagesPerCreator,
        concurrency: pageConcurrency,
        cookieHeader,
      });
      creators.push({ ...base, totalPages, count: videos.length, videos });
    } catch (e) {
      creators.push({ ...base, totalPages: 0, count: 0, videos: [], error: e.message });
    }
  });

  // Orden estable por nombre para que el JSON guardado sea predecible.
  creators.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const totalVideos = creators.reduce((n, c) => n + c.count, 0);
  return { generatedAt: Date.now(), totalCreators: creators.length, totalVideos, creators };
}

// El secreto de cifrado vive en una var/secret de Cloudflare (SHEER_KV_SECRET).
const SECRET_KEY = 'SHEER_KV_SECRET';
const resolveSecret = (env) =>
  env?.[SECRET_KEY] || (typeof process !== 'undefined' ? process.env?.[SECRET_KEY] : undefined);

// Une dos bibliotecas en modo ARCHIVO: nunca borra. Los videos se unen por
// postId (fallback videoId); los nuevos pisan a los previos (metadata fresca) y
// los que ya no aparecen en el scrape se conservan (posts borrados quedan
// archivados). Igual con los creadores: los que dejaste de seguir se mantienen.
function mergeLibrary(prev, next) {
  if (!prev || !Array.isArray(prev.creators) || !prev.creators.length) return next;

  const byAlias = new Map();
  const order = [];
  const ensure = (c) => {
    const key = String(c.alias || '').toLowerCase();
    if (!byAlias.has(key)) {
      byAlias.set(key, { ...c, videos: [...(c.videos || [])] });
      order.push(key);
    }
    return byAlias.get(key);
  };

  // Base: lo ya guardado.
  for (const c of prev.creators) ensure(c);

  // Overlay: el scrape nuevo.
  for (const nc of next.creators || []) {
    const key = String(nc.alias || '').toLowerCase();
    const existing = byAlias.get(key);
    if (!existing) { ensure(nc); continue; }

    // Metadata fresca si viene.
    if (nc.name) existing.name = nc.name;
    if (nc.headshot) existing.headshot = nc.headshot;
    if (nc.totalPages) existing.totalPages = nc.totalPages;

    // Unir videos por postId/videoId (los nuevos pisan a los previos).
    const byId = new Map();
    const keyless = [];
    for (const v of existing.videos) {
      const k = v.postId || v.videoId;
      k ? byId.set(k, v) : keyless.push(v);
    }
    for (const v of nc.videos || []) {
      const k = v.postId || v.videoId;
      k ? byId.set(k, v) : keyless.push(v);
    }
    existing.videos = [...byId.values(), ...keyless];
    if (existing.videos.length) delete existing.error; // ya hay datos válidos
  }

  const creators = order.map((k) => {
    const c = byAlias.get(k);
    c.count = c.videos.length;
    return c;
  });
  const totalVideos = creators.reduce((n, c) => n + c.count, 0);
  return { generatedAt: next.generatedAt ?? Date.now(), totalCreators: creators.length, totalVideos, creators };
}

// Troceo: un valor de KV admite hasta 25 MB, pero nos auto-imponemos un tope de
// 5 MB por valor. Si la biblioteca cifrada lo supera, se reparte en trozos
// `sheer:library:chunk:N` y `sheer:library` pasa a ser un manifiesto JSON sin
// cifrar ({ __chunked, chunks, bytes }). Ciframos por bytes y partimos el
// Uint8Array, así que un trozo puede cortar un carácter multibyte sin problema:
// al leer concatenamos los bytes descifrados y recién entonces decodificamos.
const SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB por valor de KV (auto-impuesto)
const CHUNK_BYTES = 3_500_000; // ~3.5 MB de texto → ~4.7 MB cifrado (bajo el tope)
const chunkKey = (i) => `${KV_LIBRARY}:chunk:${i}`;

// Borra trozos contiguos desde `start` hasta el primer hueco (limpia versiones
// previas con más trozos o restos al volver a un único valor).
async function deleteChunksFrom(env, start) {
  const kv = env?.VS_C3_KV;
  if (!kv || typeof kv.delete !== 'function') return;
  for (let i = start; i < start + 100000; i++) {
    const v = await kv.get(chunkKey(i));
    if (v == null) break;
    await kv.delete(chunkKey(i));
  }
}

/**
 * Persiste la biblioteca en KV (`sheer:library`) minificada y cifrada con
 * AES-256-GCM, en modo ARCHIVO: une lo nuevo con lo ya guardado (nunca borra).
 * Si el payload cifrado supera 5 MB, lo reparte en varios trozos.
 * Lanza si falta el secreto. Devuelve la biblioteca resultante (merge) o null.
 */
export async function saveLibrary(library, env) {
  if (!env?.VS_C3_KV) return null;
  const secret = resolveSecret(env);
  if (!secret) {
    throw new Error(`Falta la var/secret ${SECRET_KEY} de Cloudflare para cifrar la biblioteca.`);
  }
  const prev = await loadLibrary(env); // unir con lo previo (archivo)
  const merged = mergeLibrary(prev, library);

  const json = JSON.stringify(merged); // minificado
  const payload = await encryptString(json, secret); // AES-GCM (base64 ASCII → .length == bytes)

  if (payload.length <= SIZE_LIMIT) {
    // Cabe en un único valor.
    await env.VS_C3_KV.put(KV_LIBRARY, payload);
    await deleteChunksFrom(env, 0); // limpiar trozos de una versión troceada previa
    return merged;
  }

  // Demasiado grande: trocear los bytes del JSON y cifrar cada trozo.
  const bytes = new TextEncoder().encode(json);
  const chunks = Math.ceil(bytes.length / CHUNK_BYTES) || 1;
  for (let i = 0; i < chunks; i++) {
    const slice = bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    await env.VS_C3_KV.put(chunkKey(i), await encryptBytes(slice, secret));
  }
  await env.VS_C3_KV.put(KV_LIBRARY, JSON.stringify({ __chunked: true, chunks, bytes: bytes.length }));
  await deleteChunksFrom(env, chunks); // borrar trozos sobrantes si antes había más
  return merged;
}

/**
 * Lee y descifra la biblioteca de KV. Soporta los tres formatos de `sheer:library`:
 *   · payload cifrado "v1:…"           → valor único.
 *   · manifiesto JSON { __chunked }     → reensambla los trozos cifrados.
 *   · JSON plano (legacy sin cifrar)    → passthrough.
 * Devuelve null si no existe o falta algún trozo.
 */
export async function loadLibrary(env) {
  try {
    const kv = env?.VS_C3_KV;
    const raw = await kv?.get(KV_LIBRARY);
    if (!raw) return null;
    const secret = resolveSecret(env);

    // ¿Manifiesto de troceo? (JSON que empieza por '{', no el payload "v1:…")
    if (raw[0] === '{') {
      let manifest = null;
      try { manifest = JSON.parse(raw); } catch {}
      if (manifest && manifest.__chunked) {
        const parts = [];
        let total = 0;
        for (let i = 0; i < manifest.chunks; i++) {
          const cp = await kv.get(chunkKey(i));
          if (cp == null) return null; // trozo faltante: biblioteca incompleta
          const bytes = await decryptBytes(cp, secret);
          parts.push(bytes);
          total += bytes.length;
        }
        const buf = new Uint8Array(total);
        let off = 0;
        for (const p of parts) { buf.set(p, off); off += p.length; }
        return JSON.parse(new TextDecoder().decode(buf));
      }
    }

    return await decryptJSON(raw, secret);
  } catch {
    return null;
  }
}

// ── Modo de lectura (live ↔ guardado en KV) ──────────────────────────────────
// El modo global decide de dónde leen las páginas de videos:
//   · 'live'  → scrapean sheer.com en cada request (usa la cookie).
//   · 'saved' → leen la biblioteca cifrada de KV (`sheer:library`); sin cookie.
// Se guarda en texto plano (no es sensible) en KV `sheer:mode`.
const KV_MODE = 'sheer:mode';

/** Modo de lectura actual ('live' | 'saved'). Default 'live'. */
export async function loadMode(env) {
  try {
    const raw = await env?.VS_C3_KV?.get(KV_MODE);
    if (raw === 'saved' || raw === 'live') return raw;
  } catch {}
  return 'live';
}

/** Persiste el modo de lectura. Devuelve el modo normalizado. */
export async function saveMode(mode, env) {
  const m = mode === 'saved' ? 'saved' : 'live';
  try {
    if (env?.VS_C3_KV) await env.VS_C3_KV.put(KV_MODE, m);
  } catch {}
  return m;
}

/**
 * Feed agregado desde la biblioteca guardada: todos los videos de todos los
 * creadores. Equivalente offline a /memberships (lo consume /sheer en modo saved).
 */
export async function readLibraryFeed({ env } = {}) {
  const lib = await loadLibrary(env);
  if (!lib) return { videos: [], generatedAt: null, totalCreators: 0 };
  const all = [];
  for (const c of lib.creators || []) {
    for (const v of c.videos || []) all.push(v);
  }
  return { videos: dedupVideos(all), generatedAt: lib.generatedAt ?? null, totalCreators: lib.totalCreators ?? (lib.creators || []).length };
}

/**
 * Videos de UN creador desde la biblioteca guardada (lo consume /sheer/[alias]
 * en modo saved). Compara el alias sin distinguir mayúsculas.
 */
export async function readLibraryCreator({ alias, env } = {}) {
  const lib = await loadLibrary(env);
  if (!lib) return { videos: [], generatedAt: null, alias };
  const target = String(alias || '').toLowerCase();
  const creator = (lib.creators || []).find((c) => String(c.alias || '').toLowerCase() === target);
  return { videos: creator ? dedupVideos(creator.videos || []) : [], generatedAt: lib.generatedAt ?? null, alias };
}

/**
 * Vista de suscripciones desde la biblioteca guardada: un "creador" por cuenta
 * con una tira de posts de vista previa (primeros `previewLimit` videos). Misma
 * forma que scrapeSheerSubscriptions para que /sheer/subscriptions lo renderice
 * igual en modo guardado.
 *
 * @param {object} [opts]
 * @param {any}    [opts.env]          runtime env (para VS_C3_KV)
 * @param {number} [opts.previewLimit] posts de vista previa por creador (default 8)
 */
export async function readLibrarySubscriptions({ env, previewLimit = 8 } = {}) {
  const lib = await loadLibrary(env);
  if (!lib) return { accounts: [], generatedAt: null };
  const accounts = (lib.creators || []).map((c) => {
    const vids = c.videos || [];
    return {
      alias: c.alias,
      name: c.name || c.alias,
      headshot: c.headshot || '',
      poster: vids[0]?.poster || '',
      status: `${c.count ?? vids.length} videos`,
      posts: vids.slice(0, previewLimit).map((v) => ({
        postId: v.postId || v.videoId || '',
        url: '',
        title: v.title || '',
        poster: v.poster || '',
        // Sin clip de preview en la biblioteca: usamos la 1ª fuente para el hover.
        preview: (v.sources && v.sources[0] && v.sources[0].src) || '',
      })),
    };
  });
  return { accounts, generatedAt: lib.generatedAt ?? null };
}

export { DEFAULT_ALIAS };
