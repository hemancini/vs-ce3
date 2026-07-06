import { getRawFeedFiles } from "@/utils/ars/creator-feeds";

const MIRROR_BASE = "https://video-proxy.aroman-4f3.workers.dev/media-public/";
const LEGACY_IMAGE_BASE = "https://1796381938.rsc.cdn77.org/uploads/updates/images/";
const LEGACY_VIDEO_BASE = "https://1796381938.rsc.cdn77.org/uploads/updates/videos/";

const hasHttpUrl = (v: any) => typeof v === "string" && v.includes("://");

// Arsmate a veces devuelve el string literal "null"/"undefined" o "" en los
// campos de media. Los tratamos como vacío.
const isBlank = (v: any) =>
  v == null || v === "" || v === "null" || v === "undefined";

// El campo `image` de los JSON capturados viene en dos formatos:
//  - Path con carpetas: `pending/<userId>/images/<hash>.<ext>` → espejo público.
//  - Nombre plano (hash legacy): `<userId>...<rand>.<ext>` → CDN77 updates/images.
const imagePathToUrl = (img: string): string => {
  if (img.startsWith("http")) return img;
  const clean = img.replace(/^\/+/, "");
  return clean.includes("/") ? `${MIRROR_BASE}${clean}` : `${LEGACY_IMAGE_BASE}${clean}`;
};

// El campo `video` del snapshot viene en dos formatos (igual criterio que las
// imágenes):
//  - Ruta HLS con carpetas (`videos/<userId>/<mediaId>/hls/master.m3u8`) →
//    espejo público (`/media-public/...`).
//  - Nombre de archivo plano legacy (`<userId>...<rand>.mp4`) → CDN77
//    updates/videos (mismo destino que usa raw-posts.ts para reproducir).
const videoPathToUrl = (video: string): string => {
  if (video.startsWith("http")) return video;
  const clean = video.replace(/^\/+/, "");
  return clean.includes("/") ? `${MIRROR_BASE}${clean}` : `${LEGACY_VIDEO_BASE}${clean}`;
};

// Junta las tres listas de media donde Arsmate puede ubicar un item. En
// contenido de suscripción gateado `rawMedia` suele venir vacío y el id real sólo
// aparece en `mediaItems` / `content.images`, así que las recorremos todas.
const mediaArrays = (p: any): any[][] => [
  Array.isArray(p?.rawMedia) ? p.rawMedia : [],
  Array.isArray(p?.mediaItems) ? p.mediaItems : [],
  Array.isArray(p?.content?.images) ? p.content.images : [],
];

// ¿El media ya trae una fuente de video utilizable?
const hasVideoSource = (m: any) =>
  !isBlank(m?.hlsManifestUrl) || !isBlank(m?.videoUrl) || !isBlank(m?.video);

interface MediaSnapshot {
  type: "image" | "video";
  /** Ruta de imagen (formato carpetas o hash plano). */
  image?: string;
  /** Ruta HLS del video (`videos/<userId>/<mediaId>/hls/master.m3u8`). */
  video?: string;
}

// Mapa id de media → snapshot, construido una sola vez a partir de los JSON
// capturados (src/data/ars/feeds/). Reemplaza la antigua consulta a la BD: el
// snapshot del scraper guarda la ruta real del CDN para cada media de
// suscripción (imagen o video).
let snapshotMap: Map<number, MediaSnapshot> | null = null;
function getSnapshotMap(): Map<number, MediaSnapshot> {
  if (snapshotMap) return snapshotMap;

  const map = new Map<number, MediaSnapshot>();
  for (const feed of getRawFeedFiles()) {
    for (const post of feed.posts || []) {
      for (const m of Array.isArray(post?.rawMedia) ? post.rawMedia : []) {
        if (m?.id == null) continue;
        if (m.type === "video" && !isBlank(m.video)) {
          map.set(m.id, { type: "video", video: m.video });
        } else if (m.image) {
          map.set(m.id, { type: "image", image: m.image });
        }
      }
    }
  }
  return (snapshotMap = map);
}

/**
 * Completa la ruta de media de suscripción desde los JSON capturados.
 *
 * Arsmate entrega el contenido de suscripción gateado (`image`/`video` null,
 * `requiresToken: true`) y su ruta real en el CDN es un hash que NO se deriva del
 * id. Esa ruta la tenemos en el snapshot del scraper
 * (src/data/ars/feeds/<username>.json), tomado mientras la cuenta estaba suscrita al
 * creador. Lo servimos por el espejo público (`/media-public/...`), que no exige
 * token, tanto para imágenes (`pending/<userId>/images/<hash>.jpg`) como para
 * videos HLS (`videos/<userId>/<mediaId>/hls/master.m3u8`).
 *
 * Muta los media in-place rellenando `image` / `video` con la URL del espejo.
 */
export async function fillMediaPathsFromFeeds(posts: any[]): Promise<void> {
  if (!Array.isArray(posts) || posts.length === 0) return;

  const map = getSnapshotMap();
  if (map.size === 0) return;

  for (const p of posts) {
    for (const arr of mediaArrays(p)) {
      for (const m of arr) {
        if (m?.id == null) continue;
        const snap = map.get(m.id);
        if (!snap) continue;

        if (snap.type === "image" && snap.image && !m.image && !hasHttpUrl(m.url)) {
          m.image = imagePathToUrl(snap.image);
        } else if (snap.type === "video" && snap.video && !hasVideoSource(m)) {
          m.video = videoPathToUrl(snap.video);
        }
      }
    }
  }
}
