import type { APIRoute } from 'astro';

/**
 * Proxy Arsmate API
 * Simplificada y modernizada para el manejo de medios y manifiestos HLS.
 * Usa técnicas modernas como Headers, Fetch API y lógica modular.
 */

interface ResolveCandidatesParams {
  url?: string;
  mediaId?: string;
  userId?: string;
}

const CONFIG = {
  LEGACY_CDN: 'https://1796381938.rsc.cdn77.org',
  OLD_WORKER_PREFIX: 'https://video-proxy.aroman-4f3.workers.dev/legacy-cdn',
  PROXY_ENDPOINT: '/api/ars/proxy'
};

// --- Configuración de Legacy CDN ---
const LEGACY_CDN_BASE = 'https://1796381938.rsc.cdn77.org';
const LEGACY_VIDEO_PREFIX = `${LEGACY_CDN_BASE}/uploads/updates/videos/`;
const LEGACY_IMAGE_PREFIX = `${LEGACY_CDN_BASE}/uploads/updates/images/`;

// Variable global para habilitar/deshabilitar el reemplazo de legacy CDN
const ENABLE_LEGACY_REPLACE = true;

// --- Helpers de Utilidad ---

/**
 * Genera una URL de proxy para ser usada dentro de manifiestos HLS.
 */
const createProxyUrl = (resourceUrl: string, originalParams: URLSearchParams): string => {
  const params = new URLSearchParams();
  params.set('url', resourceUrl);
  
  ['userId', 'postId', 'mediaId', 'debug'].forEach(key => {
    const val = originalParams.get(key);
    if (val) params.set(key, val);
  });

  return `${CONFIG.PROXY_ENDPOINT}?${params.toString()}`;
};

/**
 * Resume una URL para logs más limpios.
 */
const summarize = (url: string): string => {
  try {
    const { origin, pathname } = new URL(url);
    return `${origin}${pathname}`;
  } catch {
    return url.length > 80 ? `${url.slice(0, 80)}...` : url;
  }
};

// --- Lógica de Negocio ---

/**
 * Reescribe un manifiesto M3U8 para que todos los recursos pasen por este proxy.
 */
function rewriteManifest(content: string, baseUrl: string, params: URLSearchParams): string {
  return content.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Si la línea es un comentario/tag de HLS, buscamos URIs dentro
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        try {
          const absolute = new URL(uri, baseUrl).href;
          return `URI="${createProxyUrl(absolute, params)}"`;
        } catch {
          return `URI="${uri}"`;
        }
      });
    }

    // Si la línea es una URL directa (segmento o variante)
    try {
      const absolute = new URL(trimmed, baseUrl).href;
      return createProxyUrl(absolute, params);
    } catch {
      return line;
    }
  }).join('\n');
}

function getVariantManifestUrl(content: string, baseUrl: string): string | null {
  const lines = content.split('\n');
  const variants: Array<{ url: string; bandwidth: number; width: number; height: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line?.startsWith('#EXT-X-STREAM-INF')) continue;
    const nextLine = lines[i + 1]?.trim();
    if (!nextLine || nextLine.startsWith('#')) continue;
    try {
      const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/i);
      const resolutionMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
      variants.push({
        url: new URL(nextLine, baseUrl).href,
        bandwidth: bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0,
        width: resolutionMatch ? parseInt(resolutionMatch[1], 10) : 0,
        height: resolutionMatch ? parseInt(resolutionMatch[2], 10) : 0
      });
    } catch {
      continue;
    }
  }

  if (variants.length === 0) return null;
  const hdVariants = variants.filter((variant) => variant.width > 0 && variant.width <= 1280);
  const candidates = hdVariants.length > 0 ? hdVariants : variants;
  candidates.sort((a, b) => b.bandwidth - a.bandwidth);
  return candidates[0].url;
}

function getManifestMediaRequests(content: string, baseUrl: string): Array<{ url: string; range?: string }> {
  const requests: Array<{ url: string; range?: string }> = [];
  const lines = content.split('\n');
  let pendingRange: string | undefined;
  let currentOffset = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const byterange = line.replace('#EXT-X-BYTERANGE:', '').trim();
      const [lengthPart, offsetPart] = byterange.split('@');
      const length = parseInt(lengthPart, 10);
      if (!Number.isFinite(length) || length <= 0) {
        pendingRange = undefined;
        continue;
      }
      const offset = offsetPart !== undefined ? parseInt(offsetPart, 10) : currentOffset;
      if (!Number.isFinite(offset) || offset < 0) {
        pendingRange = undefined;
        continue;
      }
      const end = offset + length - 1;
      pendingRange = `bytes=${offset}-${end}`;
      currentOffset = end + 1;
      continue;
    }

    if (line.startsWith('#')) {
      continue;
    }

    let absoluteUrl = '';
    try {
      absoluteUrl = new URL(line, baseUrl).href;
    } catch {
      pendingRange = undefined;
      continue;
    }

    if (absoluteUrl.toLowerCase().includes('.m3u8')) {
      pendingRange = undefined;
      continue;
    }

    requests.push({
      url: absoluteUrl,
      range: pendingRange
    });
    pendingRange = undefined;
  }

  return requests;
}

async function createMp4StreamFromManifest(manifestUrl: string): Promise<ReadableStream<Uint8Array> | null> {
  try {
    const childProcess = await import('node:child_process');
    const ffmpeg = childProcess.spawn('ffmpeg', [
      '-v', 'error',
      '-i', manifestUrl,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', 'frag_keyframe+empty_moov',
      '-f', 'mp4',
      'pipe:1'
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const stderrChunks: Buffer[] = [];
    ffmpeg.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    const stdout = ffmpeg.stdout;
    if (!stdout) return null;

    return new ReadableStream<Uint8Array>({
      start(controller) {
        let finalized = false;

        const cleanup = () => {
          stdout.off('data', onData);
          stdout.off('end', onEnd);
          stdout.off('error', onStdoutError);
          ffmpeg.off('error', onFfmpegError);
          ffmpeg.off('close', onFfmpegClose);
        };

        const finalizeClose = () => {
          if (finalized) return;
          finalized = true;
          cleanup();
          try {
            controller.close();
          } catch {
          }
        };

        const finalizeError = (error: Error) => {
          if (finalized) return;
          finalized = true;
          cleanup();
          try {
            controller.error(error);
          } catch {
          }
        };

        const onData = (chunk: Buffer) => {
          if (finalized) return;
          try {
            controller.enqueue(new Uint8Array(chunk));
          } catch {
            finalizeClose();
          }
        };

        const onEnd = () => {
          finalizeClose();
        };

        const onStdoutError = (error: Error) => {
          finalizeError(error);
        };

        const onFfmpegError = (error: Error) => {
          finalizeError(error);
        };

        const onFfmpegClose = (code: number | null) => {
          if (code !== 0) {
            const stderr = Buffer.concat(stderrChunks).toString('utf-8');
            finalizeError(new Error(stderr || `ffmpeg exited with code ${code ?? 'unknown'}`));
            return;
          }
          finalizeClose();
        };

        stdout.on('data', onData);
        stdout.on('end', onEnd);
        stdout.on('error', onStdoutError);
        ffmpeg.on('error', onFfmpegError);
        ffmpeg.on('close', onFfmpegClose);
      },
      cancel() {
        ffmpeg.kill('SIGKILL');
      }
    });
  } catch {
    return null;
  }
}

/**
 * Resuelve la(s) URL(s) reales del recurso — 100% por string, sin red.
 *
 * Estrategia: el contenido se sirve por el espejo público del CDN
 * (/media-public/...), que no requiere token. Por eso ya NO llamamos a
 * generate-token ni descubrimos postId (eran llamadas de red de ~500ms que para
 * esta cuenta siempre devolvían "restricted"). El CDN solo exige Referer:
 * arsmate.com, que buildUpstreamHeaders ya inyecta.
 */
function resolveCandidates(params: ResolveCandidatesParams): string[] {
  const candidates: string[] = [];
  let { url, mediaId, userId } = params;

  // 1. Legacy worker → CDN77 (videos/images, no thumbnails que dan 403 en CDN77)
  if (ENABLE_LEGACY_REPLACE && url?.includes(CONFIG.OLD_WORKER_PREFIX) && !url.includes('thumbnail.jpg')) {
    url = url
      .replace(`${CONFIG.OLD_WORKER_PREFIX}/videos/`, LEGACY_VIDEO_PREFIX)
      .replace(`${CONFIG.OLD_WORKER_PREFIX}/images/`, LEGACY_IMAGE_PREFIX);
  }

  // 2. Completar userId/mediaId desde la url si faltan (para armar el espejo)
  if (url && (!userId || !mediaId)) {
    const m =
      url.match(/\/media-(?:secure|public)\/(?:videos\/|automation\/)?([^/]+)\/([^/]+)\/hls\//i) ||
      url.match(/\/video\/([^/]+)\/([^/]+)\//i);
    if (m) {
      userId = userId || m[1];
      mediaId = mediaId || m[2];
    }
  }

  const publicMaster =
    userId && mediaId
      ? `https://video-proxy.aroman-4f3.workers.dev/media-public/videos/${userId}/${mediaId}/hls/master.m3u8`
      : null;

  // 3. Master de video que exige token (/video/ o /media-secure/ + .m3u8):
  //    priorizamos el espejo público sin token.
  const isTokenedVideoMaster =
    !!url && url.includes('.m3u8') && (url.includes('/media-secure/') || url.includes('/video/'));
  if (isTokenedVideoMaster && publicMaster) candidates.push(publicMaster);

  // 4. La url original como candidato (thumbnails, segmentos, imágenes, legacy,
  //    y manifests media-public ya resueltos van directo por acá).
  if (url) candidates.push(url);

  // 5. Sin url pero con ids → espejo público directo.
  if (!url && publicMaster) candidates.push(publicMaster);

  return [...new Set(candidates)];
}

// --- API Route Handler ---

export const GET: APIRoute = async ({ request, locals }) => {
  const reqUrl = new URL(request.url);
  const debug = reqUrl.searchParams.get('debug') === '1';
  const shouldDownload = reqUrl.searchParams.get('download') === '1';
  const shouldTranscodeMp4 = reqUrl.searchParams.get('transcode') === 'mp4';
  const rawFilename = reqUrl.searchParams.get('filename');

  // Obtener la cookie de Arsmate desde locals (inyectada por el middleware)
  const arsmateCookie = (locals as any).arsmateCookie;

  // Parámetros de entrada
  const rawUrl = reqUrl.searchParams.get('url');
  const encoding = reqUrl.searchParams.get('encoding');
  let decodedUrl = rawUrl || '';
  if (rawUrl && encoding === 'base64') {
    try { decodedUrl = atob(rawUrl); } catch { return new Response('Invalid Base64 URL', { status: 400 }); }
  }

  const candidates = resolveCandidates({
    url: decodedUrl,
    mediaId: reqUrl.searchParams.get('mediaId') || undefined,
    userId: reqUrl.searchParams.get('userId') || undefined,
  });

  if (debug) {
    console.log(`[proxy] Request for: ${summarize(decodedUrl)}`);
    console.log(`[proxy] Candidates:`, candidates.map(summarize));
  }

  const passthroughRequestHeaders = [
    'accept',
    'accept-language',
    'cache-control',
    'pragma',
    'range',
    'if-none-match',
    'if-modified-since',
    'user-agent',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site'
  ];

  const buildUpstreamHeaders = (target: string) => {
    const headers = new Headers();

    for (const h of passthroughRequestHeaders) {
      const val = request.headers.get(h);
      if (val) headers.set(h, val);
    }

    const finalCookie = arsmateCookie || request.headers.get('cookie');
    if (finalCookie) {
      headers.set('cookie', finalCookie);
    }

    const isArsmate = target.includes('arsmate.com') || target.includes('workers.dev');
    if (isArsmate) {
      headers.set('referer', 'https://arsmate.com/');
      headers.set('origin', 'https://arsmate.com');
      headers.delete('sec-fetch-dest');
      headers.delete('sec-fetch-mode');
      headers.delete('sec-fetch-site');
    } else {
      try {
        const urlObj = new URL(target);
        headers.set('referer', `${urlObj.origin}/`);
        headers.set('origin', urlObj.origin);
      } catch {
        headers.delete('referer');
        headers.delete('origin');
      }
    }

    return headers;
  };

  // Intentar candidatos secuencialmente
  let lastResponse: Response | null = null;
  let finalUrl = '';

  for (const target of candidates) {
    try {
      const headers = buildUpstreamHeaders(target);

      const isManifestPath = target.includes('.m3u8');
      if (isManifestPath) {
        headers.delete('range');
        headers.delete('if-range');
      }

      const response = await fetch(target, { headers, redirect: 'follow' });
      lastResponse = response;
      finalUrl = target;
      
      if (response.ok) break;
    } catch (e: unknown) {
      if (debug) console.error(`[proxy] Failed candidate ${summarize(target)}:`, e instanceof Error ? e.message : e);
    }
  }

  if (!lastResponse) return new Response('Proxy error: Upstream unreachable', { status: 502 });

  // Preparar headers de salida
  const outHeaders = new Headers();
  ['content-type', 'content-length', 'cache-control', 'accept-ranges', 'content-range', 'etag', 'last-modified'].forEach(h => {
    const val = lastResponse!.headers.get(h);
    if (val) outHeaders.set(h, val);
  });
  
  outHeaders.set('access-control-allow-origin', '*');
  outHeaders.set('access-control-allow-methods', 'GET, HEAD, OPTIONS');

  if (shouldDownload) {
    const fallbackName = finalUrl.includes('.m3u8') ? 'video.m3u8' : 'video.mp4';
    const safeFilename = (rawFilename || fallbackName).replace(/[^\w.\-]/g, '_');
    outHeaders.set('content-disposition', `attachment; filename="${safeFilename}"`);
  }

  // Detección y reescritura de manifiestos HLS
  const contentType = lastResponse.headers.get('content-type') || '';
  const isManifestByContentType = contentType.includes('mpegurl');
  const isImageOrGif = contentType.includes('image/') || finalUrl.match(/\.(png|jpe?g|gif|webp)$/i);
  const shouldSniffManifest = !isManifestByContentType && !isImageOrGif && finalUrl.endsWith('.m3u8');
  const isPossibleManifest = (isManifestByContentType || shouldSniffManifest) && !isImageOrGif;

  if (isPossibleManifest) {
    const manifestText = await lastResponse.text();
    const isActuallyManifest = manifestText.trimStart().startsWith('#EXTM3U');

    if (isActuallyManifest) {
      // Bloque de descarga / transcodificación
      if (shouldDownload || shouldTranscodeMp4) {
        let mediaManifestUrl = finalUrl;
        let mediaManifestText = manifestText;

        const variantUrl = getVariantManifestUrl(manifestText, finalUrl);
        if (variantUrl) {
          const variantHeaders = buildUpstreamHeaders(variantUrl);
          variantHeaders.delete('range');
          variantHeaders.delete('if-range');
          const variantResponse = await fetch(variantUrl, {
            headers: variantHeaders,
            redirect: 'follow'
          });
          if (variantResponse.ok) {
            const variantText = await variantResponse.text();
            if (variantText.trimStart().startsWith('#EXTM3U')) {
              mediaManifestUrl = variantUrl;
              mediaManifestText = variantText;
            }
          }
        }

        const mp4Stream = await createMp4StreamFromManifest(mediaManifestUrl);
        if (mp4Stream) {
          const mp4Filename = (rawFilename || 'video.mp4')
            .replace(/[^\w.\-]/g, '_')
            .replace(/\.(m3u8|ts|bin)$/i, '.mp4');

          outHeaders.delete('content-length');
          outHeaders.delete('accept-ranges');
          outHeaders.delete('content-range');
          outHeaders.delete('etag');
          outHeaders.delete('last-modified');
          outHeaders.set('content-type', 'video/mp4');
          if (shouldDownload) {
            outHeaders.set('content-disposition', `attachment; filename="${mp4Filename}"`);
          } else {
            outHeaders.delete('content-disposition');
          }

          return new Response(mp4Stream, {
            status: 200,
            statusText: 'OK',
            headers: outHeaders
          });
        }

        if (shouldTranscodeMp4 && !shouldDownload) {
          return new Response('MP4 transcode failed', { status: 502 });
        }

        const mediaRequests = getManifestMediaRequests(mediaManifestText, mediaManifestUrl);
        const mediaUrls = mediaRequests.map((request) => request.url);

        if (mediaUrls.length > 0) {
          const firstResource = mediaUrls[0];
          const isTs = /\.ts(\?|$)/i.test(firstResource);
          const fallbackName = isTs ? 'video.ts' : 'video.bin';
          const safeFilename = (rawFilename || fallbackName)
            .replace(/[^\w.\-]/g, '_')
            .replace(/\.m3u8$/i, isTs ? '.ts' : '.bin');

          outHeaders.delete('content-length');
          outHeaders.delete('accept-ranges');
          outHeaders.delete('content-range');
          outHeaders.delete('etag');
          outHeaders.delete('last-modified');
          outHeaders.set('content-type', isTs ? 'video/mp2t' : 'application/octet-stream');
          outHeaders.set('content-disposition', `attachment; filename="${safeFilename}"`);

          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              try {
                for (const mediaRequest of mediaRequests) {
                  const mediaUrl = mediaRequest.url;
                  const segmentHeaders = buildUpstreamHeaders(mediaUrl);
                  if (mediaRequest.range) {
                    segmentHeaders.set('range', mediaRequest.range);
                  } else {
                    segmentHeaders.delete('range');
                  }
                  segmentHeaders.delete('if-range');
                  const segmentResponse = await fetch(mediaUrl, {
                    headers: segmentHeaders,
                    redirect: 'follow'
                  });
                  if (!segmentResponse.ok || !segmentResponse.body) {
                    throw new Error(`Segment download failed: ${segmentResponse.status}`);
                  }

                  const reader = segmentResponse.body.getReader();
                  while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (value) controller.enqueue(value);
                  }
                }
                controller.close();
              } catch (error) {
                controller.error(error);
              }
            }
          });

          return new Response(stream, {
            status: 200,
            statusText: 'OK',
            headers: outHeaders
          });
        }
      }

      // Reescritura para streaming normal (player)
      const rewritten = rewriteManifest(manifestText, finalUrl, reqUrl.searchParams);
      outHeaders.delete('content-length');
      outHeaders.set('content-type', 'application/vnd.apple.mpegurl');
      return new Response(rewritten, { 
        status: lastResponse.status, 
        statusText: lastResponse.statusText,
        headers: outHeaders 
      });
    }

    // No es un manifiesto reescribible, devolvemos el texto original
    return new Response(manifestText, { 
      status: lastResponse.status, 
      statusText: lastResponse.statusText,
      headers: outHeaders 
    });
  }

  // Stream directo para medios binarios (imágenes, segmentos TS, etc)
  return new Response(lastResponse.body, { 
    status: lastResponse.status, 
    statusText: lastResponse.statusText,
    headers: outHeaders 
  });
};
