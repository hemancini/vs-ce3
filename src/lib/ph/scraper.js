// src/lib/ph/scraper.js
//
// Librería de scraping de Pornhub usada por la app SSR. Solo usa fetch() +
// node-html-parser, sin node:fs ni navegador, así que corre igual en
// `astro dev` (Node) y en
// Cloudflare Workers. El HTML server-side de Pornhub ya trae el listado y los
// flashvars con mediaDefinitions; solo hay que enviar las cookies (incluidas las
// de age-gate) y cabeceras tipo navegador.
//
// Diseñada para SSR on-demand: scrapeSource() trae el catálogo (rápido, 1 fetch
// por página) y opcionalmente los streams de cada video (lento, 1 fetch por
// video). En el reproductor los streams se resuelven frescos al reproducir vía
// /api/ph/stream.json, así que por defecto el catálogo se sirve sin streams.

import { parse } from 'node-html-parser';

// Lee las cookies exclusivamente desde KV. Si KV no tiene datos, no hay cookies
// (devuelve []), no se usa ningún fallback bundleado.
async function resolveCookies(source, env) {
  try {
    const raw = await env?.VS_C3_KV?.get('ph:cookies');
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

const BASE_URL = 'https://es.pornhub.com';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Cookies para saltar la interstitial de edad/consentimiento. Sin estas, Pornhub
// sirve un stub sin listado ni mediaDefinitions.
const AGE_COOKIES = {
  accessAgeDisclaimerPH: '1',
  accessAgeDisclaimerUK: '1',
  accessPH: '1',
  age_verified: '1',
  platform: 'pc',
};

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

// Fuentes scrapeables. Cookies se resuelven dinámicamente desde KV en runtime.
export const SOURCES = {
  home: {
    label: 'Inicio (es.pornhub.com)',
    listUrl: `${BASE_URL}/`,
  },
  favorites: {
    label: 'Favoritos',
    listUrl: `${BASE_URL}/users/77b53b8/videos/favorites`,
    query: 'o=newest',
  },
};


function buildCookieHeader(cookies) {
  const pairs = (cookies || []).map((c) => `${c.name}=${c.value}`);
  for (const [k, v] of Object.entries(AGE_COOKIES)) pairs.push(`${k}=${v}`);
  return pairs.join('; ');
}

async function buildCookieHeaderForSource(source, env) {
  const cookies = await resolveCookies(source, env);
  return buildCookieHeader(cookies);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url, cookieHeader, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { ...BROWSER_HEADERS, cookie: cookieHeader },
      });
      if (res.ok) return res.text();
      if (attempt === retries) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt === retries) throw err;
    }
    await sleep(600 * (attempt + 1) + Math.random() * 400); // backoff ante 429/stub
  }
  return '';
}

// Decodifica las entidades HTML más comunes (node-html-parser no siempre lo hace).
function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

// Convierte un enlace de Pornhub (absoluto o relativo) a la ruta interna de la
// app, prefijando el path con /ph: /categories/teen → /ph/categories/teen,
// https://es.pornhub.com/video?c=28 → /ph/video?c=28.
function toInternalPhHref(href) {
  if (!href) return '';
  let path = href;
  if (/^https?:\/\//i.test(href)) {
    try {
      const u = new URL(href);
      path = u.pathname + u.search;
    } catch {
      return href;
    }
  }
  if (!path.startsWith('/')) path = `/${path}`;
  return `/ph${path}`;
}

// ── Mapear un <li.pcVideoListItem> a un objeto de tarjeta ─────────────────────
function mapVideoLi(li) {
  const id = li.getAttribute('data-video-id') ?? '';
  const vkey = li.getAttribute('data-video-vkey') ?? '';

  const anchor = li.querySelector('a.linkVideoThumb');
  const href = anchor?.getAttribute('href') ?? '';
  const pageUrl = href ? (href.startsWith('http') ? href : `${BASE_URL}${href}`) : '';
  const title = decodeEntities(
    anchor?.getAttribute('title') || li.querySelector('.title a')?.textContent?.trim() || '',
  );

  const img = li.querySelector('img.thumb') || li.querySelector('img');
  const thumbnail = decodeEntities(img?.getAttribute('data-image') || img?.getAttribute('src') || '');
  const preview = decodeEntities(img?.getAttribute('data-mediabook') || '');

  const duration = li.querySelector('var.duration')?.textContent?.trim() ?? '';
  const views = li.querySelector('.views var')?.textContent?.trim() ?? '';
  const added = li.querySelector('var.added')?.textContent?.trim() ?? '';

  const ua = li.querySelector('.usernameWrap a');
  const uploaderName = decodeEntities(ua?.textContent?.trim() ?? '');
  const uploaderHref = ua?.getAttribute('href') ?? '';
  const uploaderUrl = uploaderHref
    ? uploaderHref.startsWith('http')
      ? uploaderHref
      : `${BASE_URL}${uploaderHref}`
    : '';

  return {
    id,
    vkey,
    pageUrl,
    title,
    thumbnail,
    preview,
    duration,
    views,
    added,
    uploader: { name: uploaderName, url: uploaderUrl },
  };
}

// Extrae las tarjetas de video dentro de un nodo ya parseado (un contenedor de
// catálogo, de relacionados o de recomendados). Devuelve [] si el nodo es null.
function extractVideoCards(node) {
  if (!node) return [];
  return node
    .querySelectorAll('li.pcVideoListItem')
    // Excluir los videos "recomendados"/"populares" de los dropdowns del header,
    // que no pertenecen al listado y cambian en cada request.
    .filter((li) => !li.closest('ul[class*="dropdown"]'))
    .map(mapVideoLi)
    .filter((v) => v.id);
}

// ── Extraer la lista de videos de una página de catálogo ─────────────────────
function extractVideosFromPage(html) {
  return extractVideoCards(parse(html));
}

// ── Detectar el total de páginas ─────────────────────────────────────────────
function detectTotalPages(html) {
  const root = parse(html);
  let max = 1;
  for (const a of root.querySelectorAll('ul.pagination li a, li.page_number a, .paginationBlock a')) {
    const n = parseInt(a.textContent?.trim() ?? '', 10);
    if (!isNaN(n) && n > max) max = n;
  }
  // Scroll infinito (favoritos): loadMoreData('<ajax>', '<totalPaginas>', …).
  const lm = html.match(/loadMoreData\(\s*'[^']*'\s*,\s*'?(\d+)'?/);
  if (lm) {
    const n = parseInt(lm[1], 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return max;
}

// ── Indicador "Mostrando 1-32 de 20000" ──────────────────────────────────────
// Las páginas de categoría traen un .showingCounter con el total de vídeos.
// Devolvemos el total numérico (el último número del texto) para usarlo como
// indicador de cuántos resultados tiene la categoría.
function extractTotalCount(root) {
  const txt = root.querySelector('.showingCounter')?.textContent?.replace(/\s+/g, ' ').trim() || '';
  if (!txt) return 0;
  const nums = txt.match(/[\d.,]+/g) || [];
  if (!nums.length) return 0;
  return parseInt(nums[nums.length - 1].replace(/[^\d]/g, ''), 10) || 0;
}

// ── Accesos rápidos: chips de categorías ──────────────────────────────────────
// El filtro lateral (ul.searchCategoryList) lista todas las categorías como
// items con data-value (id), data-name (slug) y el label en input[name]. Los
// convertimos en chips para saltar rápido entre categorías. Enlazamos por id
// (/ph/video?c=<id>) porque el id siempre resuelve, tenga slug o no.
function extractCategoryChips(root) {
  const out = [];
  const seen = new Set();
  for (const li of root.querySelectorAll('ul.searchCategoryList li.categoryItem')) {
    const id = li.getAttribute('data-value') || '';
    const slug = li.getAttribute('data-name') || '';
    if (!id || seen.has(id)) continue;
    const label = decodeEntities(
      li.querySelector('input')?.getAttribute('name') ||
        li.querySelector('label')?.textContent?.replace(/\s+/g, ' ').trim() ||
        slug,
    );
    if (!label) continue;
    seen.add(id);
    out.push({ id, slug, label, href: `/ph/video?c=${id}` });
  }
  return out;
}

// ── Búsquedas de tendencia (chips del top de la portada) ──────────────────────
// La portada trae <search-list type="trending" search-list='[{href,value}…]'> con
// las búsquedas destacadas ("culos enormes", "milica xxx", …). Parseamos ese JSON
// y enlazamos cada chip a la búsqueda interna /ph/video/search?search=<q>.
function extractTrendingSearches(root) {
  const el = root.querySelector('search-list[type="trending"]');
  const raw = el?.getAttribute('search-list');
  if (!raw) return [];
  let items;
  try {
    items = JSON.parse(decodeEntities(raw));
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const it of items || []) {
    const label = decodeEntities(String(it?.value || '').trim());
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, href: toInternalPhHref(it?.href || `/video/search?search=${encodeURIComponent(label)}`) });
  }
  return out;
}

function parseStreams(mediaDefs) {
  return (mediaDefs || [])
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

// ── Extraer las URLs de stream desde la página de un video ───────────────────
async function extractStreams(pageUrl, cookieHeader, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const html = await fetchHtml(pageUrl, cookieHeader);
      const m = html.match(/var\s+flashvars_\d+\s*=\s*(\{[\s\S]*?\})\s*;/);
      if (m) return parseStreams(JSON.parse(m[1]).mediaDefinitions ?? []);
    } catch {
      // 429 / stub sin flashvars → reintentar.
    }
    if (attempt < retries) await sleep(500 * (attempt + 1) + Math.random() * 300);
  }
  return [];
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

// ── Source resolver (SOURCES key OR arbitrary listUrl) ───────────────────────
function resolveListUrl({ source, listUrl, query, label }) {
  if (source && SOURCES[source]) {
    const s = SOURCES[source];
    return { listUrl: s.listUrl, query: s.query ?? '', label: s.label };
  }
  if (listUrl) {
    return { listUrl, query: query ?? '', label: label ?? listUrl };
  }
  // fallback
  const s = SOURCES['home'];
  return { listUrl: s.listUrl, query: s.query ?? '', label: s.label };
}

// Construye la URL de la página `n` del catálogo. Usa URL para fusionar bien el
// query: así soporta listUrls que ya traen parámetros (p. ej. /video?c=28) sin
// romper con un segundo «?», además de las simples (/model/<x>/videos).
const buildUrl = ({ listUrl, query }, n) => {
  try {
    const u = new URL(listUrl);
    if (query) for (const [k, v] of new URLSearchParams(query)) u.searchParams.set(k, v);
    u.searchParams.set('page', String(n));
    return u.toString();
  } catch {
    return `${listUrl}?${query ? `${query}&` : ''}page=${n}`;
  }
};

/**
 * @typedef {object} ScrapeOpts
 * @property {string}  [source]       clave de SOURCES (home|favorites)
 * @property {string}  [listUrl]      URL de catálogo arbitraria
 * @property {string}  [query]        query string extra para el listUrl
 * @property {string}  [label]        etiqueta para mostrar
 * @property {number}  [page]
 * @property {number}  [maxPages]
 * @property {boolean} [withStreams]
 * @property {number}  [concurrency]
 * @property {any}     [env]
 */

// En páginas de un performer (/model|pornstar/<slug>/videos o /users/<id>/videos)
// los videos premium del listado vienen sin bloque de uploader ni de vistas.
// Como todos pertenecen a esa persona, usamos su nombre (del <h1>) + su URL como
// uploader de fallback para las tarjetas que no lo traen. No aplica a /favorites
// ni a otras fuentes (esas sí traen uploaders por video).
function performerBaseFromListUrl(listUrl) {
  try {
    const u = new URL(listUrl);
    const m = u.pathname.match(/^\/(model|pornstar|users)\/([^/]+)\/videos\/?$/);
    return m ? `${u.origin}/${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

function applyPerformerFallback(videos, html, listUrl) {
  const base = performerBaseFromListUrl(listUrl);
  if (!base) return;
  const name = decodeEntities(
    parse(html).querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() || ''
  );
  if (!name) return;
  for (const v of videos) {
    if (!v.uploader?.name) v.uploader = { name, url: base };
  }
}

/**
 * Scrapea UNA sola página de catálogo. Pensado para el scroll infinito.
 * Acepta `source` (clave de SOURCES) o `listUrl` (URL arbitraria).
 * @param {ScrapeOpts} [opts]
 */
export async function scrapePage({ source, listUrl, query, label, page = 1, withStreams = false, concurrency = 3, env } = {}) {
  const resolved = resolveListUrl({ source, listUrl, query, label });
  const cookieHeader = await buildCookieHeaderForSource(source, env);

  let html = '';
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      html = await fetchHtml(buildUrl(resolved, page), cookieHeader);
      if (html.includes('pcVideoListItem')) break;
    } catch {}
    if (attempt < 2) await sleep(1000 * (attempt + 1) + Math.random() * 400);
  }

  if (page === 1 && /iniciar sesión|\/login|signin/i.test(html) && !html.includes('pcVideoListItem')) {
    throw new Error('Cookies expiradas o inválidas — no se obtuvo el listado.');
  }

  const totalPages = detectTotalPages(html);
  const videos = extractVideosFromPage(html);
  applyPerformerFallback(videos, html, resolved.listUrl);

  if (withStreams) {
    await runPool(videos, concurrency, async (video) => {
      video.streams = await extractStreams(video.pageUrl, cookieHeader);
    });
  }

  return { videos, totalPages, label: resolved.label };
}

/**
 * Scrapea múltiples páginas y devuelve todos los videos (deduplicados).
 * Acepta `source` (clave de SOURCES) o `listUrl` (URL arbitraria).
 * @param {ScrapeOpts} [opts]
 */
export async function scrapeSource({ source, listUrl, query, label, maxPages = 1, withStreams = false, concurrency = 3, env } = {}) {
  const resolved = resolveListUrl({ source, listUrl, query, label });
  const cookieHeader = await buildCookieHeaderForSource(source, env);

  const page1 = await fetchHtml(buildUrl(resolved, 1), cookieHeader);
  if (/iniciar sesión|\/login|signin/i.test(page1) && !page1.includes('pcVideoListItem')) {
    throw new Error('Cookies expiradas o inválidas — no se obtuvo el listado.');
  }

  // Pornhub embebe `isLoggedInUser = 1` cuando la sesión es válida (0 si no).
  // Útil para distinguir un feed personal vacío de una sesión caída en páginas
  // que requieren login (p. ej. /subscriptions).
  const authenticated = /isLoggedInUser\s*=\s*1\b/.test(page1);

  const root1 = parse(page1);
  const totalPages = detectTotalPages(page1);
  const total = extractTotalCount(root1);
  const chips = extractCategoryChips(root1);
  const searches = extractTrendingSearches(root1);
  const pages = Math.max(1, Math.min(maxPages || 1, totalPages));

  const all = extractVideosFromPage(page1);
  for (let p = 2; p <= pages; p++) {
    await sleep(300 + Math.random() * 200);
    let pageVideos = [];
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        const html = await fetchHtml(buildUrl(resolved, p), cookieHeader);
        pageVideos = extractVideosFromPage(html);
        if (pageVideos.length > 0) break;
      } catch {}
      if (attempt === 0) await sleep(1500 + Math.random() * 500);
    }
    all.push(...pageVideos);
  }

  const seen = new Set();
  const videos = all.filter((v) => (seen.has(v.id) ? false : seen.add(v.id)));
  applyPerformerFallback(videos, page1, resolved.listUrl);

  if (withStreams) {
    await runPool(videos, concurrency, async (video) => {
      video.streams = await extractStreams(video.pageUrl, cookieHeader);
    });
  }

  return { videos, totalPages, total, chips, searches, label: resolved.label, authenticated };
}

// ── Pornstars listing ─────────────────────────────────────────────────────────
function extractPornstarsFromPage(html) {
  const root = parse(html);
  return root
    .querySelectorAll('li.performerCard')
    .map((li) => {
      const anchor = li.querySelector('a[href*="/pornstar/"], a[href*="/model/"], a');
      const href = anchor?.getAttribute('href') ?? '';
      if (!href || href === '#') return null;
      const url = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      const match = url.match(/\/(pornstar|model)\/([^/?#]+)/);
      if (!match) return null;

      const img = li.querySelector('img');
      const name = decodeEntities(
        img?.getAttribute('alt')?.trim() ||
        li.querySelector('.performerCardName, .pornStarName, .modelName')?.textContent?.replace(/\s+/g, ' ').trim() || ''
      );
      if (!name) return null;

      const thumbnail = decodeEntities(
        img?.getAttribute('data-thumb_url') || img?.getAttribute('data-image') || img?.getAttribute('src') || ''
      );
      const numText = (sel) => {
        const t = li.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        return t.match(/[\d.,]+\s*[KMB]?/i)?.[0]?.replace(/\s+/g, '') ?? '';
      };
      const videosNum = numText('.videosNumber, .videosCount');
      const views = numText('.viewsNumber, .viewsCount');

      return { name, type: match[1], slug: match[2], thumbnail, videosNum, views };
    })
    .filter(Boolean);
}

// ── Listado de categorías ──────────────────────────────────────────────────────
// La página /categories trae todas las categorías como anclas con su miniatura,
// nombre (<strong> o alt) y nº de vídeos (<var>). El href apunta a /categories/<slug>
// o /video?c=<id>; lo convertimos a la ruta interna de la app.
function extractCategories(root) {
  const out = [];
  const seen = new Set();
  for (const a of root.querySelectorAll('a[href*="/categories/"], a[href*="/video?c="]')) {
    const img = a.querySelector('img');
    if (!img) continue;
    const href = a.getAttribute('href') || '';
    if (!/^\/(video\?c=|categories\/)/.test(href)) continue;
    const name = decodeEntities(
      a.querySelector('strong')?.textContent?.trim() ||
        a.getAttribute('alt')?.trim() ||
        img.getAttribute('alt')?.trim() || '',
    );
    if (!name) continue;
    const internal = toInternalPhHref(href);
    if (seen.has(internal)) continue;
    seen.add(internal);
    const thumbnail = decodeEntities(img.getAttribute('data-image') || img.getAttribute('src') || '');
    const videosNum = a.querySelector('var')?.textContent?.replace(/\s+/g, ' ').trim() || '';
    out.push({ name, href: internal, thumbnail, videosNum });
  }
  return out;
}

// La página /categories trae además la sección "Idioma en los vídeos" como anclas
// a /language/<slug>; las recogemos (deduplicadas) y capitalizamos el nombre.
function extractLanguages(root) {
  const out = [];
  const seen = new Set();
  for (const a of root.querySelectorAll('a[href*="/language/"]')) {
    const m = (a.getAttribute('href') || '').match(/\/language\/([^/?#]+)/);
    if (!m) continue;
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const raw = decodeEntities(a.textContent.replace(/\s+/g, ' ').trim()) || slug;
    const name = raw.charAt(0).toUpperCase() + raw.slice(1);
    out.push({ name, slug, href: `/ph/language/${slug}` });
  }
  return out;
}

/**
 * Scrapea el listado de categorías de Pornhub y la sección de idiomas (ambos
 * viven en la misma página /categories, así que se resuelven con un solo fetch).
 * @param {{ env?: any }} [opts]
 * @returns {Promise<{ categories: Array, languages: Array }>}
 */
export async function scrapeCategories({ env } = {}) {
  const cookieHeader = await buildCookieHeaderForSource('model', env);
  const html = await fetchHtml(`${BASE_URL}/categories`, cookieHeader);
  const root = parse(html);
  return { categories: extractCategories(root), languages: extractLanguages(root) };
}

async function fetchPornstarsPage(page, cookieHeader) {
  const url = `${BASE_URL}/pornstars?page=${page}`;
  let html = '';
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      html = await fetchHtml(url, cookieHeader);
      if (html.includes('performerCard')) break;
    } catch {}
    if (attempt < 2) await sleep(1000 * (attempt + 1) + Math.random() * 400);
  }
  return html;
}

/**
 * Scrapea una o más páginas del listado de pornstars/modelos a partir de `page`.
 * @param {{ page?: number, maxPages?: number, env?: any }} [opts]
 * @returns {Promise<{ pornstars: any[], totalPages: number }>}
 */
export async function scrapePornstars({ page = 1, maxPages = 1, env } = {}) {
  const cookieHeader = await buildCookieHeaderForSource(null, env);

  const firstHtml = await fetchPornstarsPage(page, cookieHeader);
  if (!firstHtml) throw new Error('No se pudo cargar la página de pornstars.');
  if (/iniciar sesión|\/login|signin/i.test(firstHtml) && !firstHtml.includes('performerCard')) {
    throw new Error('Cookies expiradas o inválidas.');
  }

  const totalPages = detectTotalPages(firstHtml);
  const lastPage = Math.max(page, Math.min(page + (maxPages || 1) - 1, totalPages || page));

  const all = extractPornstarsFromPage(firstHtml);
  for (let p = page + 1; p <= lastPage; p++) {
    await sleep(300 + Math.random() * 200);
    const html = await fetchPornstarsPage(p, cookieHeader);
    if (html) all.push(...extractPornstarsFromPage(html));
  }

  const seen = new Set();
  const pornstars = all.filter((s) => {
    const key = `${s.type}/${s.slug}`;
    return seen.has(key) ? false : seen.add(key);
  });

  return { pornstars, totalPages };
}

// ── Suscripciones ──────────────────────────────────────────────────────────────
// La página /users/<id>/subscriptions lista las suscripciones del usuario logueado
// dentro de <ul id="moreData">. Cada <li> trae un avatar y un enlace al perfil
// (a.usernameLink → /model/<slug>, /pornstar/<slug> o /users/<id>). Ojo: la página
// también incluye una sección de "recomendados" con li.performerCard que NO son
// suscripciones, por eso acotamos la extracción al grid #moreData.
function extractSubscriptions(html) {
  const root = parse(html);
  const container = root.querySelector('#moreData') || root;
  const out = [];
  const seen = new Set();

  for (const li of container.querySelectorAll('li')) {
    const anchor =
      li.querySelector('a.usernameLink') ||
      li.querySelector('a.userLink') ||
      li.querySelector('a[href*="/model/"], a[href*="/pornstar/"], a[href*="/users/"]');
    const href = anchor?.getAttribute('href') || '';
    const m = href.match(/\/(pornstar|model|users)\/([^/?#]+)/);
    if (!m) continue;
    const type = m[1] === 'users' ? 'user' : m[1];
    const slug = m[2];
    const key = `${type}/${slug}`;
    if (seen.has(key)) continue;

    const img = li.querySelector('img.avatar') || li.querySelector('img');
    const name = decodeEntities(
      li.querySelector('a.usernameLink')?.textContent?.replace(/\s+/g, ' ').trim() ||
      img?.getAttribute('alt')?.trim() || ''
    );
    if (!name || /^avatar de usuario$/i.test(name)) continue;

    const thumbnail = decodeEntities(
      img?.getAttribute('data-thumb_url') || img?.getAttribute('data-image') || img?.getAttribute('src') || ''
    );
    seen.add(key);
    out.push({ name, type, slug, thumbnail, videosNum: '', views: '' });
  }
  return out;
}

/**
 * Scrapea las suscripciones de un usuario: /users/<id>/subscriptions.
 * Requiere cookies de sesión (usa el fallback de cookies de 'favorites').
 * @param {{ id: string, env?: any }} opts
 * @returns {Promise<{ subscriptions: any[] }>}
 */
export async function scrapeSubscriptions({ id, env } = {}) {
  const cookieHeader = await buildCookieHeaderForSource('favorites', env);
  const html = await fetchHtml(`${BASE_URL}/users/${id}/subscriptions`, cookieHeader);
  if (!html) throw new Error('No se pudo cargar la página de suscripciones.');
  if (/iniciar sesión|\/login|signin/i.test(html) && !html.includes('performerCard')) {
    throw new Error('Cookies expiradas o inválidas.');
  }
  return { subscriptions: extractSubscriptions(html) };
}

// Normaliza un título de video al término de búsqueda que usa Pornhub:
// minúsculas, sin signos de puntuación ni tildes (pero conservando la ñ) y con
// los espacios colapsados. Permite pasar un título completo al buscador y obtener
// los mismos resultados que la web. Ej:
//   "¿Por qué el coño de las latinas se derrite al montar una polla Thick? - Creampie amateur"
//   → "por que el coño de las latinas se derrite al montar una polla thick creampie amateur"
export function titleToSearchQuery(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[áàâä]/g, 'a')
    .replace(/[éèêë]/g, 'e')
    .replace(/[íìîï]/g, 'i')
    .replace(/[óòôö]/g, 'o')
    .replace(/[úùûü]/g, 'u')
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Búsqueda de performers (pornstars + modelos) ───────────────────────────────
// El listado /pornstars solo trae el directorio destacado; muchos modelos (sobre
// todo de comunidad) no aparecen ahí. searchPerformers consulta a Pornhub en vivo
// combinando tres fuentes y deduplicando por `type/slug`:
//   1. Probe directo /pornstar/<slug> y /model/<slug> (200 = existe; 301 → /pornstars = no).
//   2. Índice /pornstars/search?search=<q> (lista difusa de pornstars/modelos).
//   3. Fallback de modelo de comunidad: /model/search redirige (301) a /users/<id>.

function slugifyPerformer(q) {
  return String(q || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractPerformerSearchResults(html) {
  const root = parse(html);
  const out = [];
  for (const li of root.querySelectorAll('#pornstarsSearchResult li')) {
    const anchor = li.querySelector('a[href*="/pornstar/"], a[href*="/model/"]');
    const href = anchor?.getAttribute('href') ?? '';
    const match = href.match(/\/(pornstar|model)\/([^/?#]+)/);
    if (!match) continue;
    const img = li.querySelector('img');
    const name = decodeEntities(img?.getAttribute('alt')?.trim() || '');
    if (!name) continue;
    const thumbnail = decodeEntities(
      img?.getAttribute('data-thumb_url') || img?.getAttribute('data-image') || img?.getAttribute('src') || ''
    );
    out.push({ name, type: match[1], slug: match[2], thumbnail, videosNum: '', views: '' });
  }
  return out;
}

// Devuelve el performer si /<type>/<slug> existe (HTTP 200). Las páginas inexistentes
// redirigen (301) a /pornstars, así que con redirect:'manual' basta mirar el status.
async function probePerformerSlug(type, slug, cookieHeader) {
  if (!slug) return null;
  try {
    const res = await fetch(`${BASE_URL}/${type}/${slug}`, {
      redirect: 'manual',
      headers: { ...BROWSER_HEADERS, cookie: cookieHeader },
    });
    if (res.status !== 200) return null;
    const root = parse(await res.text());
    const name = decodeEntities(root.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() || '');
    if (!name) return null;
    const avatar = root.querySelector('.topProfileHeader img, #getAvatar img');
    const thumbnail = decodeEntities(avatar?.getAttribute('src') || avatar?.getAttribute('data-src') || '');
    return { name, type, slug, thumbnail, videosNum: '', views: '' };
  } catch {
    return null;
  }
}

// Modelo de comunidad: /model/search?search=<q> hace 301 a /users/<id> cuando hay
// match. Devolvemos un performer type:'user' con slug=<id> (lo sirve /ph/user/<id>).
async function findCommunityModel(q, cookieHeader) {
  try {
    const res = await fetch(`${BASE_URL}/model/search?search=${encodeURIComponent(q)}`, {
      redirect: 'manual',
      headers: { ...BROWSER_HEADERS, cookie: cookieHeader },
    });
    const id = (res.headers.get('location') || '').match(/\/users\/([^/?#]+)/)?.[1];
    if (!id) return null;
    const root = parse(await fetchHtml(`${BASE_URL}/users/${id}`, cookieHeader));
    const name = decodeEntities(
      root.querySelector('.topProfileHeader .name h1, h1.name, h1')?.textContent?.replace(/\s+/g, ' ').trim() ||
      root.querySelector('title')?.textContent?.replace(/['’]s Profile.*/i, '').trim() || ''
    );
    if (!name) return null;
    const avatar = root.querySelector('.topProfileHeader img, #getAvatar img');
    const thumbnail = decodeEntities(avatar?.getAttribute('src') || avatar?.getAttribute('data-src') || '');
    return { name, type: 'user', slug: id, thumbnail, videosNum: '', views: '' };
  } catch {
    return null;
  }
}

/**
 * Busca performers en Pornhub por nombre (pornstars, modelos y modelos de comunidad).
 * @param {{ query?: string, env?: any }} [opts]
 * @returns {Promise<any[]>} lista de { name, type, slug, thumbnail }
 */
export async function searchPerformers({ query, env } = {}) {
  const q = (query || '').trim();
  if (q.length < 2) return [];

  const cookieHeader = await buildCookieHeaderForSource(null, env);
  const slug = slugifyPerformer(q);

  const [pornstarExact, modelExact, indexResults, community] = await Promise.all([
    probePerformerSlug('pornstar', slug, cookieHeader),
    probePerformerSlug('model', slug, cookieHeader),
    searchPerformerIndex(q, cookieHeader),
    findCommunityModel(q, cookieHeader),
  ]);

  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (!p || !p.slug) return;
    const key = `${p.type}/${p.slug}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };

  // Los matches exactos por slug van primero (más relevantes).
  add(pornstarExact);
  add(modelExact);
  // Solo añadimos el modelo de comunidad si el slug canónico no lo cubre ya.
  if (!seen.has(`model/${slug}`) && !seen.has(`pornstar/${slug}`)) add(community);
  for (const p of indexResults) add(p);

  return out;
}

async function searchPerformerIndex(q, cookieHeader) {
  try {
    const html = await fetchHtml(`${BASE_URL}/pornstars/search?search=${encodeURIComponent(q)}`, cookieHeader);
    return extractPerformerSearchResults(html);
  } catch {
    return [];
  }
}

// ── Página de un video: metadatos + relacionados/recomendados ──────────────────
// La página de un video ya trae en el HTML server-side el bloque de info (vistas,
// fecha, likes), el uploader (canal/modelo con sus badges y contadores), las
// categorías y los listados `.relatedVideos` / `.recommendedVideos`. Los
// extraemos de una sola pasada para alimentar la página de reproducción.

// Lee el JSON-LD VideoObject (título, descripción, fecha, miniatura, duración).
function extractVideoLd(root) {
  for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const o = JSON.parse(s.textContent);
      if (o && (o['@type'] === 'VideoObject' || o.name)) return o;
    } catch {}
  }
  return {};
}

function extractVideoMeta(root) {
  const ld = extractVideoLd(root);

  const title = decodeEntities(
    root.querySelector('h1.title span, h1.title')?.textContent?.replace(/\s+/g, ' ').trim() ||
      ld.name || '',
  );
  const views = root.querySelector('.ratingInfo .views .count')?.textContent?.trim() || '';
  const date = root.querySelector('.ratingInfo .videoInfo')?.textContent?.replace(/\s+/g, ' ').trim() || '';
  const votesUp = root.querySelector('.votesUp')?.textContent?.trim() || '';
  const description = decodeEntities(ld.description || '');
  const uploadDate = ld.uploadDate || '';

  // Uploader (canal o modelo) con sus badges y contadores.
  const info = root.querySelector('.userInfo');
  const a = info?.querySelector('.usernameWrap a');
  const upName = decodeEntities(a?.textContent?.replace(/\s+/g, ' ').trim() || '');
  const upHref = a?.getAttribute('href') || '';
  const upUrl = upHref ? (upHref.startsWith('http') ? upHref : `${BASE_URL}${upHref}`) : '';
  const upType = info?.querySelector('.usernameWrap')?.getAttribute('data-type') || '';
  // El avatar a veces vive fuera de .userInfo (.userAvatar / .avatarTrigger),
  // así que ampliamos la búsqueda al documento como fallback.
  const avatarImg =
    info?.querySelector('img') ||
    root.querySelector('.userAvatar img, .avatarTrigger img, .topProfileHeader img');
  const avatar = decodeEntities(avatarImg?.getAttribute('src') || avatarImg?.getAttribute('data-src') || '');
  const badges = (info?.querySelectorAll('.userBadges') || [])
    .map((b) => decodeEntities(b.getAttribute('data-title') || ''))
    .filter(Boolean);

  let videosCount = '';
  let subscribers = '';
  for (const sp of info?.querySelectorAll('span') || []) {
    const t = sp.textContent.replace(/\s+/g, ' ').trim();
    if (!videosCount && /[Vv]í?deos/.test(t)) videosCount = t;
    else if (!subscribers && /Suscriptores|Subscribers/i.test(t)) subscribers = t;
  }

  const categories = (root.querySelector('.categoriesWrapper')?.querySelectorAll('a.item') || [])
    .map((el) => ({
      label: decodeEntities(el.textContent.replace(/\s+/g, ' ').trim()),
      href: toInternalPhHref(el.getAttribute('href') || ''),
    }))
    .filter((c) => c.label);

  return {
    title,
    views,
    date,
    votesUp,
    description,
    uploadDate,
    categories,
    uploader: {
      name: upName,
      url: upUrl,
      type: upType,
      avatar,
      badges,
      videosCount,
      subscribers,
    },
  };
}

// ── Estrellas porno del video ──────────────────────────────────────────────────
// Bajo el reproductor, Pornhub lista las performers etiquetadas en el video dentro
// de `.pornstarsWrapper` como anclas `a.pstar-list-btn` con su avatar, el nombre
// (texto del ancla) y un href a /pornstar/<slug>, /model/<slug> o /users/<id>.
function extractVideoPornstars(root) {
  const wrap = root.querySelector('.pornstarsWrapper');
  if (!wrap) return [];
  const out = [];
  const seen = new Set();
  for (const a of wrap.querySelectorAll('a.pstar-list-btn')) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/\/(pornstar|model|users)\/([^/?#]+)/);
    if (!m) continue;
    const type = m[1] === 'users' ? 'user' : m[1];
    const slug = m[2];
    const key = `${type}/${slug}`;
    if (seen.has(key)) continue;

    const img = a.querySelector('img');
    const name = decodeEntities(a.textContent.replace(/\s+/g, ' ').trim());
    if (!name) continue;
    const thumbnail = decodeEntities(
      img?.getAttribute('data-thumb_url') || img?.getAttribute('data-image') || img?.getAttribute('src') || ''
    );
    seen.add(key);
    out.push({ name, type, slug, thumbnail, url: `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}` });
  }
  return out;
}

/**
 * Scrapea la página de un video: metadatos + relacionados + recomendados.
 * @param {{ vkey?: string, pageUrl?: string, env?: any }} [opts]
 * @returns {Promise<{ meta: object, pornstars: any[], related: any[], recommended: any[] }>}
 */
export async function scrapeVideoPage({ vkey, pageUrl, env } = {}) {
  if (!pageUrl && vkey) pageUrl = `${BASE_URL}/view_video.php?viewkey=${vkey}`;
  if (!pageUrl) throw new Error('Falta el parámetro vkey o pageUrl');

  // Las cookies del modelo incluyen el age-gate; suficientes para la página de video.
  const cookieHeader = await buildCookieHeaderForSource('model', env);
  const html = await fetchHtml(pageUrl, cookieHeader);
  const root = parse(html);

  const meta = extractVideoMeta(root);
  const pornstars = extractVideoPornstars(root);
  const related = extractVideoCards(root.querySelector('.relatedVideos'));
  const recommended = extractVideoCards(root.querySelector('.recommendedVideos'));

  return { meta, pornstars, related, recommended };
}
