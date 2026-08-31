// src/lib/vodscene/media.ts
//
// Helpers de URLs de media para vodscene. El bucket público antiguo
// (`pub-39b00a75b19646c9a296925579d9d5bb.r2.dev`) ya no responde (401): el
// contenido público (imágenes, gifs, tráilers) se sirve ahora desde
// `videos.vodscene.com` con la MISMA estructura de paths, y el video completo
// (DASH con DRM) se sirve a través del proxy interno de vodscene
// (`https://vodscene.com/api/video/{videoId}/master.mpd`), que:
//   · exige `Authorization: Bearer <idToken de Firebase>` de la cuenta,
//   · devuelve 200 solo si la cuenta tiene acceso (compra/suscripción/admin),
//   · devuelve 404 si no hay acceso (entonces solo queda el tráiler público).
//
// Por eso toda URL de media pasa por nuestro proxy (`/api/vodscene/media`),
// que resuelve el idToken de la cuenta activa (igual que el endpoint de
// Firestore), agrega los headers correctos y devuelve la respuesta con
// `Access-Control-Allow-Origin: *`, reescribiendo manifiestos HLS/DASH para
// que sus segmentos también pasen por el proxy.

export const OLD_CDN = "https://pub-39b00a75b19646c9a296925579d9d5bb.r2.dev";
export const NEW_CDN = "https://videos.vodscene.com";
export const VODSCENE_ORIGIN = "https://vodscene.com";
export const FULL_VIDEO_BASE = `${VODSCENE_ORIGIN}/api/video`;

export const MEDIA_PROXY_PATH = "/api/vodscene/media";

/** Reescribe el host del CDN antiguo al nuevo (misma ruta). */
export function rewriteMediaHost(url: string | undefined | null): string {
  if (!url) return "";
  if (url.startsWith(OLD_CDN)) return NEW_CDN + url.slice(OLD_CDN.length);
  return url;
}

/**
 * URL del video completo (DASH on-demand con DRM) servida por el proxy interno
 * de vodscene. Requiere el idToken de la cuenta en el proxy local.
 */
export function fullVideoUrl(videoId: string): string {
  return `${FULL_VIDEO_BASE}/${encodeURIComponent(videoId)}/master.mpd`;
}

/**
 * Convierte una URL de media en la URL de nuestro proxy.
 *
 * Estrategia tras la actualización del backend:
 *  · Imágenes/gifs/tráilers (públicos): se sirven desde el nuevo CDN con la
 *    misma ruta; el proxy solo agrega CORS.
 *  · Manifiestos de video completo (dash / hls-fp / dash-nodrm): los archivos
 *    ya no existen en el CDN público; se mapean al DASH completo de
 *    `vodscene.com/api/video/{id}/master.mpd` (que valida acceso por token).
 */
export function proxiedMediaUrl(
  url: string | undefined | null,
  opts?: { videoId?: string },
): string {
  let target = url ? rewriteMediaHost(url) : "";

  // Manifiestos de video completo → master.mpd autenticado.
  if (/(dash|full-fp|\.mpd|master\.m3u8)/.test(target)) {
    target = "";
  }
  if (!target && opts?.videoId) {
    target = fullVideoUrl(opts.videoId);
  }
  if (!target) return "";
  return `${MEDIA_PROXY_PATH}?url=${encodeURIComponent(target)}`;
}

/** URL pública (imágenes/gifs) directa desde el nuevo CDN — sin proxy. */
export function publicImageUrl(url: string | undefined | null): string {
  return rewriteMediaHost(url);
}
