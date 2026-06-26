// Scraper por SSR puro: en vez de Playwright, descargamos cada página
// `?page=N` con node:https (incluyendo la cookie de sesión) y parseamos el HTML
// con node-html-parser. El sitio server-renderiza 10 posts por página con su
// <video><source> .mp4 inline, así que no hace falta navegador ni hover. Las
// dependencias de Node (node:fs, node:path, node:https, dotenv,
// node-html-parser) se importan dinámicamente dentro del handler porque el
// filesystem solo existe en `astro dev` (Node), no en Cloudflare Workers.

// --- Consolidación / normalización de videos ---
const normStr = (s) => (s == null ? '' : String(s).replace(/&amp;/g, '&'));
const isEmpty = (s) => s == null || String(s).trim() === '';
const isPlaceholder = (url) => /placeholder|default|blank|no[-_]?image|spacer/i.test(url);
const sizeNum = (s) => parseInt(s ?? '0', 10) || 0;

/**
 * Deduplica por postId OR contentId OR title (unión transitiva) y consolida
 * cada grupo en un único objeto normalizado. Devuelve el array limpio ordenado
 * por postId numérico descendente.
 */
const consolidateVideos = (videos) => {
  // Union-Find: cada registro se enlaza a sus claves (postId / contentId / title)
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  videos.forEach((v, i) => {
    const node = `rec:${i}`;
    find(node);
    if (!isEmpty(v.postId)) union(node, `post:${v.postId}`);
    if (!isEmpty(v.contentId)) union(node, `content:${v.contentId}`);
    if (!isEmpty(v.title)) union(node, `title:${v.title}`);
  });

  const groups = new Map();
  videos.forEach((_, i) => {
    const r = find(`rec:${i}`);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });

  const consolidate = (idxs) => {
    const recs = idxs.map((i) => videos[i]);

    const contentId = recs.map((r) => r.contentId).find((x) => !isEmpty(x)) || '';
    const postId = recs.map((r) => r.postId).find((x) => !isEmpty(x)) || '';
    const alias = recs.map((r) => r.alias).find((x) => !isEmpty(x)) || '';

    // title: no vacío, el más largo (normalizando entidad &amp;)
    const title = recs
      .map((r) => normStr(r.title))
      .filter((x) => !isEmpty(x))
      .sort((a, b) => b.length - a.length)[0] || '';

    // poster: no vacío, preferir no-placeholder
    const posters = recs.map((r) => normStr(r.poster)).filter((x) => !isEmpty(x));
    const poster = posters.find((p) => !isPlaceholder(p)) || posters[0] || '';

    // models / tags: unión + dedup por id
    const mergeById = (key) => {
      const seen = new Map();
      for (const r of recs) {
        for (const item of r[key] || []) {
          const id = item.id ?? '';
          const k = id !== '' ? `id:${id}` : `name:${item.name ?? ''}`;
          if (!seen.has(k)) seen.set(k, item);
        }
      }
      return Array.from(seen.values());
    };
    const models = mergeById('models');
    const tags = mergeById('tags');

    // views: el mayor valor numérico encontrado entre los duplicados
    const views = recs
      .map((r) => (r.views == null ? null : Number(r.views)))
      .filter((x) => x != null && !Number.isNaN(x))
      .reduce((max, x) => (x > max ? x : max), null);

    // date: primer valor no vacío
    const date = recs.map((r) => normStr(r.date)).find((x) => !isEmpty(x)) || '';

    // duration: primer valor no vacío (formato "MM:SS" o "HH:MM:SS")
    const duration = recs.map((r) => normStr(r.duration)).find((x) => !isEmpty(x)) || '';

    // sources: unión, normalizar &amp;, dedup por src, ordenar por size desc
    const seenSrc = new Map();
    for (const r of recs) {
      for (const s of r.sources || []) {
        const src = normStr(s.src);
        if (isEmpty(src)) continue;
        if (!seenSrc.has(src)) {
          seenSrc.set(src, { src, size: s.size, bitrate: s.bitrate, _videoId: r.videoId });
        }
      }
    }
    const merged = Array.from(seenSrc.values()).sort((a, b) => sizeNum(b.size) - sizeNum(a.size));

    // videoId asociado a la fuente de mayor resolución (primera tras ordenar)
    const videoId = merged.length
      ? merged[0]._videoId
      : recs.map((r) => r.videoId).find((x) => !isEmpty(x)) || '';

    const sources = merged.map(({ _videoId, ...s }) => s);

    return { postId, videoId, contentId, alias, title, poster, models, tags, views, date, duration, sources };
  };

  return Array.from(groups.values())
    .map(consolidate)
    // descartar sin sources válidas, salvo que tengan postId/contentId único
    .filter((v) => (v.sources && v.sources.length > 0) || !isEmpty(v.postId) || !isEmpty(v.contentId))
    .sort((a, b) => (parseInt(b.postId, 10) || 0) - (parseInt(a.postId, 10) || 0));
};

export const GET = async (context) => {
  const { request } = context;
  const url = new URL(request.url);
  const maxPagesParam = url.searchParams.get('maxPages') || '';

  // Binding de KV (en dev lo provee el platformProxy de Miniflare). El resultado
  // se persiste aquí además de en videos.json.
  const kv = context.locals?.runtime?.env?.VS_C3_KV ?? null;
  const KV_KEY = 'sheer:videos';

  // Carga diferida de dependencias Node-only (no se bundlean para Cloudflare).
  // En producción (Cloudflare Workers) node:https/node:fs no existen: el scraper
  // SOLO funciona en local con `astro dev`. Si fallan, devolvemos un error
  // legible por SSE en vez de un 500 crudo.
  let https, fs, path, dotenv, parseHtml;
  try {
    https = (await import('node:https')).default;
    fs = (await import('node:fs')).default;
    path = (await import('node:path')).default;
    dotenv = (await import('dotenv')).default;
    ({ parse: parseHtml } = await import('node-html-parser'));
  } catch (e) {
    const msg = 'El scraper solo puede ejecutarse en local (astro dev). Cloudflare Workers no soporta el filesystem para leer cookies/escribir videos.json. Scrapea en local y sube los datos a KV.';
    const body =
      `event: log\ndata: ${JSON.stringify({ message: `[ERROR] ${msg}`, isError: true })}\n\n` +
      `event: status\ndata: ${JSON.stringify({ status: 'error', message: msg })}\n\n`;
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  const rootDir = process.cwd();

  // Load environment variables from .env
  dotenv.config({ path: path.resolve(rootDir, '.env') });

  const encoder = new TextEncoder();

  // Create SSE stream
  const stream = new ReadableStream({
    async start(controller) {
      let streamClosed = false;

      const sendSSE = (type, dataObj) => {
        if (streamClosed) return;
        try {
          const payload = `event: ${type}\ndata: ${JSON.stringify(dataObj)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Controller is closed (client disconnected) — silence all errors
          streamClosed = true;
        }
      };

      sendSSE('status', { status: 'started', message: 'Iniciando scraper SSR (fetch) en el servidor Astro...' });

      let isAborted = false;

      // Handle client cancellation
      request.signal.addEventListener('abort', () => {
        isAborted = true;
        streamClosed = true;
        console.log('Client aborted SSE connection. Stopping scraper...');
      });

      try {
        const loginUrl = process.env.LOGIN_URL || 'https://www.sheer.com/TheGrey';

        // Read cookies
        const cookiesPath = path.resolve(rootDir, 'config/cookies.json');
        if (!fs.existsSync(cookiesPath)) {
          throw new Error('cookies.json no encontrado! Por favor asegúrate de configurar las cookies.');
        }

        let cookies = [];
        try {
          cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
        } catch (err) {
          throw new Error(`Error al leer/procesar cookies.json: ${err.message}`);
        }
        const cookieHeader = cookies
          .filter((c) => c && c.name)
          .map((c) => `${c.name}=${c.value}`)
          .join('; ');

        sendSSE('log', { message: `Loaded ${cookies.length} cookies from ${cookiesPath}` });

        const saveProgress = async (videosList) => {
          // Consolidar: dedup por postId/contentId/title + normalización antes de guardar
          const cleanList = consolidateVideos(videosList);
          const payload = JSON.stringify(cleanList, null, 2);

          // 1) Archivo (lo importan estáticamente las páginas de /sheer en build)
          try {
            const apiJsonPath = path.resolve(process.cwd(), 'src/pages/api/sheer/videos.json');
            const apiJsonDir = path.dirname(apiJsonPath);
            if (!fs.existsSync(apiJsonDir)) {
              fs.mkdirSync(apiJsonDir, { recursive: true });
            }
            fs.writeFileSync(apiJsonPath, payload, 'utf8');
          } catch (e) {
            console.error('Error guardando videos.json:', e);
          }

          // 2) KV (VS_C3_KV) — fuente persistente para runtime/producción
          if (kv) {
            try {
              await kv.put(KV_KEY, payload);
            } catch (e) {
              console.error('Error guardando en VS_C3_KV:', e);
            }
          }
        };

        // --- HTTP GET con node:https. Usamos maxHeaderSize ampliado porque el
        // servidor manda muchísimas cabeceras Set-Cookie y el fetch nativo
        // (undici) revienta con HeadersOverflowError. ---
        const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
        const fetchPage = (pageNum) => new Promise((resolve, reject) => {
          const u = new URL(loginUrl);
          u.searchParams.set('page', String(pageNum));
          const req = https.request({
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: 'GET',
            maxHeaderSize: 256 * 1024,
            headers: {
              cookie: cookieHeader,
              'user-agent': USER_AGENT,
              accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'accept-language': 'en-US,en;q=0.9',
            },
          }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { data += d; });
            res.on('end', () => resolve({ status: res.statusCode, html: data }));
          });
          req.on('error', reject);
          req.end();
        });

        // --- Parseo de una página SSR: extrae los videos del HTML con
        // node-html-parser (mismos campos que extraía el evaluate de Playwright). ---
        const parsePage = (html) => {
          const root = parseHtml(html);
          return root.querySelectorAll('article.post[data-post-id]').map((post) => {
            const video = post.querySelector('video.js-video-source, video');
            const sources = video
              ? video.querySelectorAll('source')
                  .map((s) => ({
                    src: normStr(s.getAttribute('src')),
                    size: s.getAttribute('size'),
                    bitrate: s.getAttribute('bitrate'),
                  }))
                  .filter((s) => !isEmpty(s.src))
              : [];

            const postId = post.getAttribute('data-post-id') || '';
            const videoId = video ? (video.getAttribute('data-video-id') || '') : '';
            const contentId = video ? (video.getAttribute('data-content-id') || '') : '';
            const alias = video ? (video.getAttribute('data-alias') || '') : '';

            // title: data-post-title es lo más fiable; fallback a selectores de texto
            let title = post.querySelector('[data-post-title]')?.getAttribute('data-post-title') || '';
            if (!title) {
              title = (post.querySelector('.post-title, .title, .video-title, h3, h4, .post-text')?.text || '').trim();
            }

            // poster: en SSR vive en data-poster del <video>; fallback a la imagen
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

            const models = post.querySelectorAll('.post__featuring-models__list-item')
              .map((el) => ({ id: el.getAttribute('data-model-id') || '', name: el.text.trim() }))
              .filter((mdl) => mdl.name);

            const tags = post.querySelectorAll('.post-tags__item')
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
        };

        if (isAborted) return;

        sendSSE('log', { message: `Descargando primera página: ${loginUrl}?page=1` });
        const first = await fetchPage(1);

        if (first.status === 401 || first.status === 403 ||
            /name=["']?password|type=["']?password/i.test(first.html)) {
          throw new Error(`Sesión no válida (HTTP ${first.status} o página de login). Las cookies de sesión pueden haber expirado.`);
        }

        // total_pages viene en el JSON de APP_CONFIG:
        // ...,"pagination":{"page":"1","total_pages":40}
        const tpMatch = first.html.match(/"total_pages"\s*:\s*(\d+)/);
        const totalPages = tpMatch ? parseInt(tpMatch[1], 10) : 1;
        sendSSE('log', { message: `Autenticado correctamente. Total de páginas: ${totalPages}` });

        const envMaxPages = parseInt(maxPagesParam || process.env.MAX_PAGES, 10);
        const maxPages = (!isNaN(envMaxPages) && envMaxPages > 0) ? Math.min(envMaxPages, totalPages) : totalPages;
        if (maxPages !== totalPages) {
          sendSSE('log', { message: `Límite aplicado: scrapeando solo ${maxPages} de ${totalPages} páginas` });
        }

        const allVideos = [];
        const seenKeys = new Set();

        const ingest = (videos) => {
          for (const v of videos) {
            if (!v.sources || v.sources.length === 0) continue;
            const key = v.postId || v.videoId;
            if (key && seenKeys.has(key)) continue;
            if (key) seenKeys.add(key);
            allVideos.push(v);
          }
        };

        // Página 1 ya descargada
        ingest(parsePage(first.html));
        sendSSE('videos_found', { count: allVideos.length });
        sendSSE('progress', { current: 1, total: maxPages });

        // Resto de páginas con concurrencia limitada (pool de workers sobre una cola)
        const CONCURRENCY = 4;
        let nextPage = 2;
        let completedPages = 1;

        const worker = async () => {
          while (!isAborted) {
            const pageNum = nextPage++;
            if (pageNum > maxPages) return;
            try {
              const { html } = await fetchPage(pageNum);
              const videos = parsePage(html);
              ingest(videos);
              sendSSE('log', { message: `Página ${pageNum}/${maxPages}: ${videos.length} posts (total ${allVideos.length})` });
            } catch (e) {
              sendSSE('log', { message: `Error en página ${pageNum}: ${e.message}`, isError: true });
            } finally {
              completedPages++;
              sendSSE('videos_found', { count: allVideos.length });
              sendSSE('progress', { current: completedPages, total: maxPages });
              // Guardado progresivo cada 5 páginas
              if (completedPages % 5 === 0) await saveProgress(allVideos);
            }
          }
        };

        const poolSize = Math.min(CONCURRENCY, Math.max(0, maxPages - 1));
        await Promise.all(Array.from({ length: poolSize }, worker));

        if (isAborted) return;

        sendSSE('log', { message: `Extracción completa. Total de videos: ${allVideos.length}` });
        sendSSE('complete', { total: allVideos.length });

        // Guardado final
        await saveProgress(allVideos);
        sendSSE('log', { message: `Metadata guardada en videos.json${kv ? ' y en VS_C3_KV' : ' (VS_C3_KV no disponible)'}.` });

        sendSSE('status', { status: 'finished', code: 0, message: 'Scraping completado con éxito' });
        if (!streamClosed) {
          streamClosed = true;
          controller.close();
        }

      } catch (err) {
        console.error('Fatal error during scraping session in SSE:', err);
        sendSSE('log', { message: `[ERROR] ${err.message}`, isError: true });
        sendSSE('status', { status: 'error', message: err.message });

        if (!streamClosed) {
          streamClosed = true;
          try {
            controller.close();
          } catch (e) {}
        }
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    }
  });
};
