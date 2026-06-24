/**
 * scripts/ph/scrape.mjs
 *
 * Extrae los metadatos de todos los videos del modelo Nico Grey en Pornhub
 * incluyendo las URLs directas del stream (HLS m3u8 por calidad + mp4), y los
 * guarda en src/pages/api/ph/videos.json.
 *
 * Usa fetch() + node-html-parser (sin navegador): el HTML server-side de Pornhub
 * ya trae el listado y los flashvars con mediaDefinitions. Solo hace falta enviar
 * las cookies (incluidas las de age-gate) y cabeceras tipo navegador.
 *
 * Uso:
 *   node scripts/ph/scrape.mjs                     (scrapea todas las fuentes)
 *   node scripts/ph/scrape.mjs --source favorites  (solo favoritos)
 *   node scripts/ph/scrape.mjs --source model      (solo el modelo)
 *   node scripts/ph/scrape.mjs --max-pages 3       (limitar a N páginas)
 *   node scripts/ph/scrape.mjs --concurrency 4     (páginas de video en paralelo, default 3)
 *   node scripts/ph/scrape.mjs --skip-streams      (omitir la visita a cada video, más rápido)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'node-html-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────────────
const BASE_URL = 'https://es.pornhub.com';
const API_DIR = path.resolve(__dirname, '../../src/pages/api/ph');

// Fuentes a scrapear. Cada una tiene su listado, cookies y JSON de salida. Los
// JSON se generan dentro de src/pages/api/ph para servirlos como API
// (/api/ph/videos.json, /api/ph/favorites.json) y empaquetarlos en el build.
const SOURCES = {
  model: {
    label: 'Modelo (nico-grey)',
    listUrl: `${BASE_URL}/model/nico-grey/videos`,
    cookiesPath: path.resolve(__dirname, 'cookies.json'),
    output: path.join(API_DIR, 'videos.json'),
  },
  favorites: {
    label: 'Favoritos',
    listUrl: `${BASE_URL}/users/77b53b8/videos/favorites`,
    // Los favoritos paginan con scroll infinito; requieren el parámetro de orden
    // `o=newest` para que `?page=N` devuelva la página correcta (si no, da 403).
    query: 'o=newest',
    cookiesPath: path.resolve(__dirname, 'cookies-fav.json'),
    output: path.join(API_DIR, 'favorites.json'),
  },
};

// Construye la URL de la página N de un listado (incluye el query extra si lo hay).
const buildPageUrl = (src, n) => `${src.listUrl}?${src.query ? `${src.query}&` : ''}page=${n}`;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Cookies para saltar la interstitial de edad/consentimiento (sin estas, Pornhub
// sirve un stub sin listado ni mediaDefinitions).
const AGE_COOKIES = {
  accessAgeDisclaimerPH: '1',
  accessAgeDisclaimerUK: '1',
  accessPH: '1',
  age_verified: '1',
  platform: 'pc',
};

// CLI args
const args = process.argv.slice(2);
const getArg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] != null ? args[i + 1] : fallback;
};
const MAX_PAGES = parseInt(getArg('--max-pages', '0'), 10); // 0 = sin límite
const CONCURRENCY = parseInt(getArg('--concurrency', '3'), 10); // páginas de video en paralelo
const SKIP_STREAMS = args.includes('--skip-streams');
const SOURCE = getArg('--source', 'all'); // model | favorites | all

// ── fetch helper ──────────────────────────────────────────────────────────────
let COOKIE_HEADER = '';

function buildCookieHeader(cookies) {
  const pairs = cookies.map((c) => `${c.name}=${c.value}`);
  for (const [k, v] of Object.entries(AGE_COOKIES)) pairs.push(`${k}=${v}`);
  return pairs.join('; ');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
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
          cookie: COOKIE_HEADER,
        },
      });
      if (res.ok) return res.text();
      if (attempt === retries) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt === retries) throw err;
    }
    await sleep(700 * (attempt + 1) + Math.random() * 500); // backoff ante 429/stub
  }
}

// Decodifica las entidades HTML más comunes (node-html-parser no lo hace siempre).
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

// ── Extraer lista de videos de una página de catálogo ────────────────────────
function extractVideosFromPage(html) {
  const root = parse(html);
  return root
    .querySelectorAll('li.pcVideoListItem')
    .map((li) => {
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
    })
    .filter((v) => v.id);
}

// ── Detectar total de páginas ─────────────────────────────────────────────────
function detectTotalPages(html) {
  const root = parse(html);
  let max = 1;
  for (const a of root.querySelectorAll('ul.pagination li a, li.page_number a, .paginationBlock a')) {
    const n = parseInt(a.textContent?.trim() ?? '', 10);
    if (!isNaN(n) && n > max) max = n;
  }
  // Listados con scroll infinito (p. ej. favoritos): el total de páginas está en
  // loadMoreData('<ajax>', '<totalPaginas>', '<paginaActual>').
  const lm = html.match(/loadMoreData\(\s*'[^']*'\s*,\s*'?(\d+)'?/);
  if (lm) {
    const n = parseInt(lm[1], 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return max;
}

// ── Extraer URLs directas del stream desde la página de un video ──────────────
/**
 * Devuelve un array de fuentes ordenadas de mayor a menor calidad. Lee los
 * flashvars embebidos en el HTML. Reintenta con backoff porque Pornhub limita
 * peticiones rápidas (devuelve 429 o un stub sin flashvars). Si tras los
 * reintentos no hay mediaDefinitions → [].
 */
async function extractStreams(pageUrl, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const html = await fetchHtml(pageUrl);
      const m = html.match(/var\s+flashvars_\d+\s*=\s*(\{[\s\S]*?\})\s*;/);
      if (m) {
        const mediaDefs = JSON.parse(m[1]).mediaDefinitions ?? [];
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
      // Sin flashvars: probablemente stub por rate-limit → reintentar.
    } catch {
      // Error de red / HTTP (p. ej. 429) → reintentar.
    }
    if (attempt < retries) await sleep(600 * (attempt + 1) + Math.random() * 400);
  }
  return [];
}

// ── Pool de concurrencia ──────────────────────────────────────────────────────
async function runPool(tasks, concurrency, worker) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function next() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await worker(tasks[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
  return results;
}

// ── Scrape de una fuente (modelo o favoritos) ─────────────────────────────────
async function scrapeSource(src) {
  if (!fs.existsSync(src.cookiesPath)) {
    console.warn(`\n⚠️   [${src.label}] Sin cookies (${path.basename(src.cookiesPath)}). Se omite.`);
    return;
  }
  const cookies = JSON.parse(fs.readFileSync(src.cookiesPath, 'utf8'));
  COOKIE_HEADER = buildCookieHeader(cookies);

  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(`📂  Fuente: ${src.label}`);
  console.log(`🍪  ${cookies.length} cookies  |  🌐  ${src.listUrl}`);
  if (SKIP_STREAMS) console.log(`⚡  Modo rápido (--skip-streams)`);

  const allVideos = [];

  // ── Paso 1: scrape de páginas de catálogo ──────────────────────────
  console.log(`\n📄  Cargando página 1…`);
  const page1Html = await fetchHtml(buildPageUrl(src, 1));
  if (/iniciar sesión|\/login|signin/i.test(page1Html) && !page1Html.includes('pcVideoListItem')) {
    throw new Error('Cookies expiradas o inválidas — no se obtuvo el listado.');
  }

  const totalPages = detectTotalPages(page1Html);
  const pagesToScrape = MAX_PAGES > 0 ? Math.min(MAX_PAGES, totalPages) : totalPages;
  console.log(`📚  Páginas detectadas: ${totalPages}  |  A scrapear: ${pagesToScrape}`);

  const page1Videos = extractVideosFromPage(page1Html);
  allVideos.push(...page1Videos);
  console.log(`   ✅  Página 1 → ${page1Videos.length} videos (total: ${allVideos.length})`);

  for (let p = 2; p <= pagesToScrape; p++) {
    console.log(`\n📄  Cargando página ${p}/${pagesToScrape}…`);
    try {
      const html = await fetchHtml(buildPageUrl(src, p));
      const videos = extractVideosFromPage(html);
      allVideos.push(...videos);
      console.log(`   ✅  Página ${p} → ${videos.length} videos (total: ${allVideos.length})`);
    } catch (err) {
      console.warn(`   ⚠️   Error en página ${p}: ${err.message}. Continuando…`);
    }
  }

  // ── Deduplicar ─────────────────────────────────────────────────────
  const seen = new Set();
  const unique = allVideos.filter((v) => {
    if (seen.has(v.id)) return false;
    seen.add(v.id);
    return true;
  });
  console.log(`\n🎞️   ${unique.length} videos únicos encontrados.`);

  // ── Paso 2: obtener URLs de stream por video ───────────────────────
  if (!SKIP_STREAMS) {
    console.log(`\n🔗  Extrayendo URLs de stream (concurrencia: ${CONCURRENCY})…`);
    let done = 0;

    await runPool(unique, CONCURRENCY, async (video) => {
      const streams = await extractStreams(video.pageUrl);
      video.streams = streams;
      done++;
      const best = streams.find((s) => s.default) ?? streams[0];
      const label = best ? `${best.quality}p ${best.format}` : 'sin stream';
      console.log(`   [${done}/${unique.length}] ${video.title.slice(0, 60)} → ${label}`);
    });
  }

  // ── Guardar ────────────────────────────────────────────────────────
  // Guarda de seguridad: no sobrescribir el JSON con un resultado vacío
  // (p. ej. si Pornhub rate-limitó y devolvió stubs sin listado).
  if (unique.length === 0) {
    throw new Error(`0 videos extraídos. No se sobrescribe ${path.basename(src.output)}.`);
  }

  fs.writeFileSync(src.output, JSON.stringify(unique, null, 2), 'utf8');
  console.log(`\n🎉  [${src.label}] ${unique.length} videos guardados en:\n   ${src.output}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const keys = SOURCE === 'all' ? Object.keys(SOURCES) : [SOURCE];
  const invalid = keys.filter((k) => !SOURCES[k]);
  if (invalid.length) {
    console.error(`❌  Fuente desconocida: ${invalid.join(', ')}. Usa: ${Object.keys(SOURCES).join(' | ')} | all`);
    process.exit(1);
  }

  // Cada fuente se aísla: si una falla (cookies caducadas, rate-limit) las demás
  // continúan y no se pierde lo ya generado.
  for (const k of keys) {
    try {
      await scrapeSource(SOURCES[k]);
    } catch (err) {
      console.error(`❌  [${SOURCES[k].label}] ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error('❌  Error fatal:', err.message);
  process.exit(1);
});
