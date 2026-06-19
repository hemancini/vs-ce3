// Las dependencias de Node (playwright, node:fs, node:path, dotenv) se importan
// dinámicamente dentro del handler. Este endpoint SOLO funciona en `astro dev`
// (Node): Cloudflare Workers no tiene navegador ni filesystem. El scraping se
// ejecuta en local y el resultado se guarda en KV (VIDEOS_KV), que en dev usa
// el KV local de Miniflare gracias a platformProxy.

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

export const GET = async ({ request }) => {
  const url = new URL(request.url);
  const maxPagesParam = url.searchParams.get('maxPages') || '';

  // Carga diferida de dependencias Node-only (no se bundlean para Cloudflare).
  // En producción (Cloudflare Workers) estos módulos no existen: el scraper SOLO
  // funciona en local con `astro dev`. Si fallan, devolvemos un error legible por
  // SSE en vez de un 500 crudo.
  let chromium, fs, path, dotenv;
  try {
    ({ chromium } = await import('playwright'));
    fs = (await import('node:fs')).default;
    path = (await import('node:path')).default;
    dotenv = (await import('dotenv')).default;
  } catch (e) {
    const msg = 'El scraper solo puede ejecutarse en local (astro dev). Cloudflare Workers no soporta Playwright ni el filesystem. Scrapea en local y sube los datos a KV.';
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

      sendSSE('status', { status: 'started', message: 'Iniciando Playwright en el servidor Astro...' });

      let browser = null;
      let isAborted = false;

      // Handle client cancellation
      request.signal.addEventListener('abort', async () => {
        isAborted = true;
        streamClosed = true;
        console.log('Client aborted SSE connection. Closing Playwright...');
        if (browser) {
          try {
            await browser.close();
          } catch (e) {
            console.error('Error closing browser on abort:', e);
          }
        }
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
          cookies = cookies.map(cookie => {
            const cleaned = { ...cookie };
            if (cleaned.sameSite) {
              const normalized = cleaned.sameSite.charAt(0).toUpperCase() + cleaned.sameSite.slice(1).toLowerCase();
              if (['Strict', 'Lax', 'None'].includes(normalized)) {
                cleaned.sameSite = normalized;
              } else {
                delete cleaned.sameSite;
              }
            }
            return cleaned;
          });
        } catch (err) {
          throw new Error(`Error al leer/procesar cookies.json: ${err.message}`);
        }

        if (isAborted) return;

        sendSSE('log', { message: `Loaded ${cookies.length} cookies from ${cookiesPath}` });

        sendSSE('log', { message: 'Launching browser...' });
        browser = await chromium.launch({ headless: true });

        const context = await browser.newContext({
          viewport: { width: 1280, height: 720 }
        });

        // Bloquear descargas innecesarias (solo leemos el DOM, no reproducimos media)
        await context.route('**/*', (route) => {
          const t = route.request().resourceType();
          return (t === 'image' || t === 'media' || t === 'font')
            ? route.abort()
            : route.continue();
        });

        if (isAborted) {
          await browser.close();
          return;
        }

        sendSSE('log', { message: 'Injecting session cookies...' });
        await context.addCookies(cookies);

        const page = await context.newPage();

        const targetUrl = new URL(loginUrl);
        targetUrl.searchParams.set('page', '1');

        if (isAborted) {
          await browser.close();
          return;
        }

        sendSSE('log', { message: `Navigating to first page: ${targetUrl.toString()}` });
        await page.goto(targetUrl.toString(), { waitUntil: 'load' });

        if (isAborted) {
          await browser.close();
          return;
        }

        // Check if redirect to login occurred
        const usernameInput = page.locator('input[type="email"], input[type="text"], input[name="email"], input[name="username"]').first();
        try {
          await usernameInput.waitFor({ state: 'visible', timeout: 4000 });
          throw new Error('Redirigido a la página de login o campos visibles. Las cookies de sesión pueden haber expirado.');
        } catch (e) {
          // OK, no login inputs found
          if (e.message.includes('Redirigido')) {
            throw e;
          }
        }

        // Get total pages
        const totalPages = await page.evaluate(() => {
          return window.APP_CONFIG?.pagination?.total_pages || 1;
        });

        sendSSE('log', { message: `Successfully authenticated. Total pages found: ${totalPages}` });

        const envMaxPages = parseInt(maxPagesParam || process.env.MAX_PAGES, 10);
        const maxPages = (!isNaN(envMaxPages) && envMaxPages > 0) ? Math.min(envMaxPages, totalPages) : totalPages;
        if (maxPages !== totalPages) {
          sendSSE('log', { message: `Limit applied: Scraping only up to ~${maxPages} pages worth of posts` });
        }

        const allVideos = [];

        const saveProgress = (videosList) => {
          try {
            // Consolidar: dedup por postId/contentId/title + normalización antes de guardar
            const cleanList = consolidateVideos(videosList);

            const apiJsonPath = path.resolve(process.cwd(), 'src/pages/api/sheer/videos.json');
            const apiJsonDir = path.dirname(apiJsonPath);
            if (!fs.existsSync(apiJsonDir)) {
              fs.mkdirSync(apiJsonDir, { recursive: true });
            }
            fs.writeFileSync(apiJsonPath, JSON.stringify(cleanList, null, 2), 'utf8');
          } catch (e) {
            console.error('Error in progressive saveProgress:', e);
          }
        };

        // El sitio usa scroll infinito: navegamos a page=1 y vamos haciendo scroll
        // hasta el fondo para que carguen más posts. El antiguo loop de ?page=N se
        // quedaba atascado en "1/40" porque este mismo scroll nunca dejaba de cargar
        // posts y el while interno jamás terminaba la página 1.
        const pageUrl = new URL(loginUrl);
        pageUrl.searchParams.set('page', '1');

        sendSSE('log', { message: `Cargando catálogo (scroll infinito): ${pageUrl.toString()}` });
        await page.goto(pageUrl.toString(), { waitUntil: 'load' });

        try {
          await page.waitForSelector('article.post[data-post-id], video.js-video-source', { timeout: 8000 });
        } catch (e) {
          sendSSE('log', { message: `Warning: Post container selector not found within 8s.` });
        }

        if (isAborted) {
          await browser.close();
          return;
        }

        const posts = page.locator('article.post[data-post-id]');

        // Estimación de posts por "página" para la barra de progreso
        const initialCount = await posts.count();
        const perPage = initialCount > 0 ? initialCount : 10;
        // Objetivo de posts a cargar (respeta el límite maxPages si se pidió)
        const targetPosts = perPage * maxPages;
        let estimatedTotal = targetPosts;
        const limitApplied = maxPages < totalPages;
        // Tope duro de seguridad: nunca debe quedar en bucle infinito
        const HARD_CAP = targetPosts > 0 ? targetPosts + perPage * 2 : 5000;

        sendSSE('log', { message: `Posts iniciales: ${initialCount}. Objetivo estimado: ${targetPosts}` });

        const seenKeys = new Set();
        let processedIndex = 0;
        let noGrowthTicks = 0;
        const MAX_NO_GROWTH = 4;

        while (true) {
          if (isAborted) {
            await browser.close();
            return;
          }

          const currentCount = await posts.count();
          const limit = Math.min(currentCount, HARD_CAP);

          // Procesar (hover + extraer) los posts nuevos cargados hasta ahora
          for (let i = processedIndex; i < limit; i++) {
            if (isAborted) {
              await browser.close();
              return;
            }
            const post = posts.nth(i);
            try {
              await post.scrollIntoViewIfNeeded({ timeout: 2000 });
              await post.hover({ timeout: 2000 });
              // Esperar al evento real (que se inyecte el <source>) en vez de un fijo de 400ms
              await post.locator('video source').first()
                .waitFor({ state: 'attached', timeout: 1500 }).catch(() => {});

              const videoLocator = post.locator('video.js-video-source, video');
              const videoCount = await videoLocator.count().catch(() => 0);
              if (videoCount > 0) {
                const videoData = await videoLocator.first().evaluate((video) => {
                  const videoId = video.getAttribute('data-video-id');
                  const contentId = video.getAttribute('data-content-id');
                  const alias = video.getAttribute('data-alias');

                  const sources = Array.from(video.querySelectorAll('source')).map(source => ({
                    src: source.getAttribute('src'),
                    size: source.getAttribute('size'),
                    bitrate: source.getAttribute('bitrate')
                  }));

                  const postContainer = video.closest('article.post[data-post-id]');
                  const postId = postContainer ? postContainer.getAttribute('data-post-id') : '';
                  let title = '';
                  if (postContainer) {
                    // Try data attribute first (most reliable)
                    const dislikeBtn = postContainer.querySelector('[data-post-title]');
                    if (dislikeBtn) {
                      title = dislikeBtn.getAttribute('data-post-title');
                    }
                    // Fallback to text selectors
                    if (!title) {
                      const titleEl = postContainer.querySelector('.post-title, .title, .video-title, h3, h4, .post-text');
                      if (titleEl) {
                        title = titleEl.textContent.trim();
                      }
                    }
                  }

                  let poster = video.getAttribute('poster') || '';
                  if (!poster && postContainer) {
                    const imgEl = postContainer.querySelector('img.video-poster__img, img.video-poster__background');
                    if (imgEl) {
                      poster = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '';
                    }
                    if (!poster) {
                      const bgEl = postContainer.querySelector('.video-poster__background');
                      if (bgEl) {
                        const bgStyle = bgEl.getAttribute('style') || '';
                        const match = bgStyle.match(/url\(['"]?([^'"]+)['"]?\)/);
                        if (match) {
                          poster = match[1];
                        }
                      }
                    }
                  }
                  if (poster) {
                    poster = poster.replace(/&amp;/g, '&');
                  }

                  // Extract featuring models (actrices)
                  const models = [];
                  if (postContainer) {
                    postContainer.querySelectorAll('.post__featuring-models__list-item').forEach((el) => {
                      const name = (el.textContent || '').trim();
                      const id = el.getAttribute('data-model-id') || '';
                      if (name) models.push({ id, name });
                    });
                  }

                  // Extract tags (categorías)
                  const tags = [];
                  if (postContainer) {
                    postContainer.querySelectorAll('.post-tags__item').forEach((li) => {
                      const alias = li.getAttribute('data-tag-alias') || '';
                      const id = li.getAttribute('data-tag-id') || '';
                      const link = li.querySelector('.post-tags__link');
                      const name = link ? link.textContent.trim() : alias;
                      if (alias || name) tags.push({ id, alias, name });
                    });
                  }

                  // Extract views count
                  let views = null;
                  if (postContainer) {
                    const viewsEl = postContainer.querySelector('.post__counter--views strong');
                    if (viewsEl) {
                      const raw = (viewsEl.textContent || '').replace(/[^\d]/g, '');
                      if (raw) views = parseInt(raw, 10);
                    }
                  }

                  // Extract publish date (e.g. "Jan 18, 2023")
                  let date = '';
                  if (postContainer) {
                    const dateEl = postContainer.querySelector('.post__date-text, .post__date');
                    if (dateEl) date = (dateEl.textContent || '').trim();
                  }

                  // Extract runtime / duration (e.g. "23:01")
                  let duration = '';
                  if (postContainer) {
                    const durationEl = postContainer.querySelector('.runtime-tag span, .runtime-tag');
                    if (durationEl) duration = (durationEl.textContent || '').trim();
                  }

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
                    sources
                  };
                }).catch(() => null);

                if (videoData && videoData.sources && videoData.sources.length > 0) {
                  const key = videoData.postId || videoData.videoId || `idx:${i}`;
                  if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    allVideos.push(videoData);
                    sendSSE('log', { message: `Extracted: "${videoData.title}" (Post ID: ${videoData.postId})` });
                    sendSSE('videos_found', { count: allVideos.length });
                    // Guardado progresivo cada 50 videos nuevos
                    if (allVideos.length % 50 === 0) saveProgress(allVideos);
                  }
                }
              } else {
                sendSSE('log', { message: `Hovered post index ${i} - No video tag found` });
              }
            } catch (e) {
              sendSSE('log', { message: `Error processing post index ${i}: ${e.message}` });
            }
          }

          processedIndex = limit;
          if (estimatedTotal < currentCount) estimatedTotal = currentCount;
          sendSSE('progress', { current: processedIndex, total: estimatedTotal });

          // ¿Alcanzamos el tope de seguridad o el límite pedido por maxPages?
          if (processedIndex >= HARD_CAP) {
            sendSSE('log', { message: `Tope de seguridad alcanzado (${processedIndex} posts). Deteniendo.` });
            break;
          }
          if (limitApplied && processedIndex >= targetPosts) {
            sendSSE('log', { message: `Límite maxPages alcanzado: ${processedIndex} posts (~${maxPages} páginas).` });
            break;
          }

          // Scroll hasta el fondo para disparar la carga de más posts
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(800);

          const newCount = await posts.count();
          if (newCount === currentCount) {
            noGrowthTicks++;
            sendSSE('log', { message: `Sin posts nuevos tras scroll (${noGrowthTicks}/${MAX_NO_GROWTH}). Cargados: ${newCount}` });
            if (noGrowthTicks >= MAX_NO_GROWTH) {
              sendSSE('log', { message: `No hay más contenido para cargar. Fin del scroll.` });
              break;
            }
          } else {
            noGrowthTicks = 0;
          }
        }

        if (isAborted) {
          await browser.close();
          return;
        }

        sendSSE('log', { message: `Extraction complete. Total videos collected: ${allVideos.length}` });
        sendSSE('complete', { total: allVideos.length });

        // Save detailed JSON one final time to be safe
        saveProgress(allVideos);
        sendSSE('log', { message: `Successfully saved all metadata files.` });

        // Finished browser
        await browser.close();
        browser = null;

        sendSSE('status', { status: 'finished', code: 0, message: 'Scraping completado con éxito' });
        if (!streamClosed) {
          streamClosed = true;
          controller.close();
        }

      } catch (err) {
        console.error('Fatal error during scraping session in SSE:', err);
        sendSSE('log', { message: `[ERROR] ${err.message}`, isError: true });
        sendSSE('status', { status: 'error', message: err.message });

        if (browser) {
          try {
            await browser.close();
          } catch (e) {}
        }
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
