import { getRawFeedFiles } from "@/utils/ars/creator-feeds";

// Bases de CDN/espejo, mismas que usa el feed real (ver media-fallback.ts y
// feed.ts). Las imágenes con ruta de carpetas van al espejo público; los
// nombres planos (hash legacy) y los videos van al CDN77 de updates.
const CDN_IMAGES = "https://1796381938.rsc.cdn77.org/uploads/updates/images/";
const CDN_VIDEOS = "https://1796381938.rsc.cdn77.org/uploads/updates/videos/";
const MIRROR_PUBLIC = "https://video-proxy.aroman-4f3.workers.dev/media-public/";

// `image` viene en dos formatos:
//  - Ruta con carpetas (`pending/<userId>/images/<hash>.jpg`) → espejo público.
//  - Nombre plano (hash legacy) → CDN77 updates/images.
function buildImageUrl(image?: string | null): string | null {
  if (!image) return null;
  if (image.startsWith("http")) return image;
  const clean = image.replace(/^\/+/, "");
  return clean.includes("/") ? `${MIRROR_PUBLIC}${clean}` : `${CDN_IMAGES}${clean}`;
}

// `video` es un nombre de archivo plano (a veces con prefijo `videos/`) que vive
// en el CDN77 de updates/videos. PostCard lo sirve directo (cdn77 no pasa por el
// proxy local).
function buildVideoUrl(video?: string | null): string | null {
  if (!video) return null;
  if (video.startsWith("http")) return video;
  const clean = video.replace(/^videos\//, "");
  return `${CDN_VIDEOS}${clean}`;
}

export interface RawCreatorFeed {
  /** Username del creador de origen (para depurar / deep-links). */
  file: string;
  creatorInfo: { id: number; username: string; endDate?: string };
  /** Posts ya normalizados con `mediaItems` listos para PostCard. */
  posts: any[];
  counts: {
    total: number;
    videos: number;
    photos: number;
    mixed: number;
    text: number;
  };
}

// Convierte un item de `rawMedia` (campos `image`/`video` con nombres de
// archivo) al shape que PostCard espera en `mediaItems` (URLs completas).
function normalizeMedia(m: any): any | null {
  if (!m) return null;
  const isVideo = m.type === "video" || (!!m.video && !m.image);
  if (isVideo) {
    const video = buildVideoUrl(m.video);
    if (!video) return null;
    return { id: m.id, type: "video", video, videoMime: "video/mp4" };
  }
  const image = buildImageUrl(m.image);
  if (!image) return null;
  return { id: m.id, type: "image", image, url: image };
}

// Adapta un post crudo del scraper al objeto que consume PostCard.astro:
// fuerza el desbloqueo (el media se sirve por CDN/espejo público) y deja el
// media en `mediaItems` con URLs resolubles.
function normalizePost(post: any, creator: RawCreatorFeed["creatorInfo"]): any {
  const mediaItems = (Array.isArray(post.rawMedia) ? post.rawMedia : [])
    .map(normalizeMedia)
    .filter(Boolean);

  // En el scraper `filterType` es "subscription" | "free" | "ppv". Lo usamos
  // sólo para el badge; el media igual se muestra desbloqueado.
  const isPremiumContent = post.filterType && post.filterType !== "free";

  return {
    id: post.id,
    postType: post.type,
    contentType: isPremiumContent ? "Suscripción" : "Gratis",
    text: post.description || "",
    description: post.description || "",
    creatorName: creator.username,
    creatorAvatar: null,
    mediaItems,
    likes: 0,
    comments: 0,
    isPremiumContent,
    realPrice: 0,
    price: 0,
    // Desbloqueo forzado: igual criterio que el feed real (ver feed.ts).
    isLocked: false,
    locked: "no",
    hasAccess: true,
    // Metadatos de origen, útiles en el bloque "Ver JSON Raw".
    filterType: post.filterType,
    sourceType: post.type,
  };
}

let cache: RawCreatorFeed[] | null = null;

/**
 * Normaliza todos los JSON de feeds (src/data/ars/feeds/), agrupados por creador.
 * Los datos se cargan vía `import.meta.glob` (ver creator-feeds.ts), sin node:fs,
 * y el resultado se cachea en memoria por proceso (los archivos son estáticos).
 */
export function loadRawCreatorFeeds(): RawCreatorFeed[] {
  if (cache) return cache;

  const feeds: RawCreatorFeed[] = getRawFeedFiles().map((raw) => {
    const creatorInfo = raw.creatorInfo || ({} as RawCreatorFeed["creatorInfo"]);
    const rawPosts: any[] = Array.isArray(raw.posts) ? raw.posts : [];
    const posts = rawPosts.map((p) => normalizePost(p, creatorInfo));

    return {
      file: creatorInfo.username || "",
      creatorInfo,
      posts,
      counts: {
        total: rawPosts.length,
        videos: rawPosts.filter((p) => p.type === "video").length,
        photos: rawPosts.filter((p) => p.type === "photos").length,
        mixed: rawPosts.filter((p) => p.type === "mixed").length,
        text: rawPosts.filter((p) => p.type === "text").length,
      },
    };
  });

  // getRawFeedFiles() ya devuelve los feeds ordenados por username.
  return (cache = feeds);
}
