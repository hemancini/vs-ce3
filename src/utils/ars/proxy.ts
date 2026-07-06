
const LEGACY_CDN_BASE = 'https://1796381938.rsc.cdn77.org';
const OLD_WORKER_PREFIX = 'https://video-proxy.aroman-4f3.workers.dev/legacy-cdn';

/**
 * Realiza la operación INVERSA: pasa las URLs legacy del worker (proxy) al CDN77 original.
 * Según el archivo Nuxt de Arsmate:
 * Worker legacy: https://video-proxy.aroman-4f3.workers.dev/legacy-cdn/avatar/...
 * CDN77 legacy: https://1796381938.rsc.cdn77.org/uploads/avatar/...
 */
export function replaceLegacyUrl(url: string | null | undefined): string {
  if (!url) return '';
  
  // Clean URL: remove whitespace and backticks
  const urlStr = String(url).trim().replace(/^`|`$/g, '').trim();

  // Si ya es una URL completa de CDN77 o el nuevo worker, no tocarla
  if (urlStr.includes('cdn77.org') || urlStr.includes('video-proxy.aroman-4f3.workers.dev/profile/')) {
    return urlStr;
  }

  // Mapeo según la lógica de Arsmate proporcionada:
  // t = https://1796381938.rsc.cdn77.org
  // e = https://video-proxy.aroman-4f3.workers.dev (Worker que maneja /profile/ y /media-public/)

  // 1. Avatares
  if (urlStr.includes(`${OLD_WORKER_PREFIX}/avatar/`)) {
    return urlStr.replace(`${OLD_WORKER_PREFIX}/avatar/`, `${LEGACY_CDN_BASE}/uploads/avatar/`);
  }

  // 2. Covers
  if (urlStr.includes(`${OLD_WORKER_PREFIX}/cover/`)) {
    return urlStr.replace(`${OLD_WORKER_PREFIX}/cover/`, `${LEGACY_CDN_BASE}/uploads/cover/`);
  }

  // 3. Videos (Updates) - Solo si NO es un thumbnail
  if (urlStr.includes(`${OLD_WORKER_PREFIX}/videos/`) && !urlStr.includes('thumbnail.jpg')) {
    return urlStr.replace(`${OLD_WORKER_PREFIX}/videos/`, `${LEGACY_CDN_BASE}/uploads/updates/videos/`);
  }

  // 4. Imágenes (Updates) - Solo si NO es un thumbnail
  if (urlStr.includes(`${OLD_WORKER_PREFIX}/images/`) && !urlStr.includes('thumbnail.jpg')) {
    return urlStr.replace(`${OLD_WORKER_PREFIX}/images/`, `${LEGACY_CDN_BASE}/uploads/updates/images/`);
  }

  // 5. Mensajes
  if (urlStr.includes(`${OLD_WORKER_PREFIX}/messages/`)) {
    return urlStr.replace(`${OLD_WORKER_PREFIX}/messages/`, `${LEGACY_CDN_BASE}/uploads/messages/`);
  }

  // 6. Thumbnails de videos (Worker nuevo que maneja /video/ o legacy con thumbnail.jpg)
  // Los thumbnails de video deben pasar por el proxy porque dan 403 directo en CDN77
  if (urlStr.includes('video-proxy.aroman-4f3.workers.dev/video/') || urlStr.includes('thumbnail.jpg')) {
    return urlStr; // No lo cambiamos a CDN77 aquí, dejamos que getProxiedUrl lo maneje
  }
  
  return urlStr;
}

// Utility to generate proxied URLs for Arsmate content
export function getProxiedUrl(url: string | number | undefined | null) {
  if (!url) return '';
  
  // Clean URL: remove whitespace and backticks
  let urlStr = String(url).trim().replace(/^`|`$/g, '').trim();

  // Primero aplicar el reemplazo de legacy si es necesario
  const replacedUrl = replaceLegacyUrl(urlStr);
  
  // Si la URL contiene cdn77, la devolvemos directa (sin pasar por el proxy /api/ars/proxy)
  if (replacedUrl.includes('cdn77.org')) {
    return replacedUrl;
  }

  // Las imágenes de perfil (avatar/cover) del worker son públicas: no exigen
  // Referer (200 desde cualquier origen), igual que cdn77 → directo, sin el
  // salto del proxy. El contenido de posts (media-secure/media-public/video)
  // sí necesita el proxy y no matchea este patrón.
  if (replacedUrl.includes('video-proxy.aroman-4f3.workers.dev/profile/')) {
    return replacedUrl;
  }

  urlStr = replacedUrl;

  if (urlStr.startsWith('/api/ars/proxy?')) return urlStr;
  if (urlStr.startsWith('/')) return urlStr;

  if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
    return `/api/ars/proxy?url=${encodeURIComponent(urlStr)}`;
  }

  // If it's just a filename (legacy image), we might need to construct a full URL
  // But for now, let's at least ensure we don't return something that breaks the browser
  // If it doesn't look like a URL, it might be a relative path that needs the proxy
  if (urlStr && !urlStr.includes(':')) {
    // Check if it's a known legacy pattern (e.g. starts with userId)
    // For now, if it's just a filename, it's probably better to try to find a full URL version
    return urlStr;
  }

  return urlStr;
}

// Utility to format dates consistently
export function formatDate(dateString: string) {
    return new Date(dateString).toLocaleDateString('es-CL', {
        day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}
