import { getProxiedUrl, formatDate, replaceLegacyUrl } from "@/utils/ars/proxy";
import type { ArsmateFeedResponse, ArsmatePost, ArsmateMedia } from "@/types/arsmate";
import { fillMediaPathsFromFeeds } from "@/utils/ars/media-fallback";
import { normalizeArsLegacyUrls } from "@/lib/ars/creators";

// Servicio compartido para obtener el feed de Arsmate (con enriquecimiento de
// media). Se llama DIRECTAMENTE desde el endpoint /api/ars/posts/feed y desde
// el partial /ars/posts/feed-cards, evitando el loopback HTTP hacia el propio hostname que en Cloudflare
// Pages devuelve el HTML de la SPA. Ver nota en src/lib/ars/creators.ts.

export interface FeedParams {
    creatorId?: string | null;
    limit?: string;
    page?: string;
    contentFilter?: string;
    ordenacion?: string;
    filtroMedia?: string;
}

export interface FetchFeedResult {
    ok: boolean;
    status: number;
    data?: ArsmateFeedResponse;
    error?: string;
    details?: string;
}

export async function fetchArsFeed(
    params: FeedParams,
    cookie: string | undefined,
    userId?: string,
): Promise<FetchFeedResult> {
    if (!cookie) {
        return { ok: false, status: 401, error: "No se pudo obtener la sesión de Arsmate." };
    }

    const creatorId = params.creatorId;
    const limit = params.limit || "10";
    const page = params.page || "1";
    const contentFilter = params.contentFilter || "all";
    const ordenacion = params.ordenacion || "recientes";
    const filtroMedia = params.filtroMedia || "todos";

    // Sin creatorId la API de Arsmate devuelve el feed global (home). Con
    // creatorId, el feed de ese creador. Por eso creatorId es opcional aquí.
    const apiUrl = new URL("https://arsmate.com/api/posts/feed");
    if (creatorId) apiUrl.searchParams.set("creatorId", creatorId);
    apiUrl.searchParams.set("limit", limit);
    apiUrl.searchParams.set("page", page);
    apiUrl.searchParams.set("contentFilter", contentFilter);
    apiUrl.searchParams.set("ordenacion", ordenacion);
    apiUrl.searchParams.set("filtroMedia", filtroMedia);
    if (userId) apiUrl.searchParams.set("userId", userId);

    try {
        const res = await fetch(apiUrl.toString(), {
            headers: {
                Cookie: cookie,
                "User-Agent":
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Accept: "application/json, text/plain, */*",
                Origin: "https://arsmate.com",
                Referer: "https://arsmate.com/",
            },
        });

        if (!res.ok) {
            return { ok: false, status: res.status, error: `Error de la API de Arsmate: ${res.status}` };
        }

        const data: ArsmateFeedResponse = await res.json();

        // 1. Normalizar URLs en TODO el objeto de datos antes de cualquier procesamiento.
        const normalizedData: ArsmateFeedResponse = JSON.parse(
            normalizeArsLegacyUrls(JSON.stringify(data)),
        );

        // Completa la ruta de media gateada (imágenes y videos) desde los JSON capturados (ver media-fallback).
        if (normalizedData.success && Array.isArray(normalizedData.posts)) {
            await fillMediaPathsFromFeeds(normalizedData.posts as any[]);
        }

        const getPostTimestamp = (post: ArsmatePost) => {
            const rawValue = (post as any).createdAt || (post as any).created_at || (post as any).date;
            if (!rawValue) return 0;
            const timestamp = new Date(String(rawValue)).getTime();
            return Number.isFinite(timestamp) ? timestamp : 0;
        };

        // Enrich data with formats expected by the frontend (V1 parity)
        if (normalizedData.success && Array.isArray(normalizedData.posts)) {
            normalizedData.posts.sort((a: ArsmatePost, b: ArsmatePost) => {
                const timeA = getPostTimestamp(a);
                const timeB = getPostTimestamp(b);
                return ordenacion === "antiguos" ? timeA - timeB : timeB - timeA;
            });

            normalizedData.posts = normalizedData.posts.map((post: ArsmatePost) => {
                const user = post.author || post.user;

                // --- ROBUST MEDIA NORMALIZATION ---
                const normalizedMedia: ArsmateMedia[] = [];

                // Fusiona un media sin pisar valores reales con null/''. matchByType:
                // objetos sin id (p.ej. post.media en contenido de suscripción) se unen
                // al item del mismo tipo en vez de duplicar.
                const mergeMedia = (item: any, matchByType = false) => {
                    if (!item) return;
                    const itemType = item.type || (item.video ? "video" : item.image ? "image" : undefined);
                    let idx = item.id != null ? normalizedMedia.findIndex((m) => m.id === item.id) : -1;
                    if (idx === -1 && matchByType && item.id == null && itemType) {
                        idx = normalizedMedia.findIndex(
                            (m: any) => (m.type || (m.video ? "video" : "image")) === itemType,
                        );
                    }
                    if (idx === -1) {
                        normalizedMedia.push({ ...item });
                        return;
                    }
                    const merged: any = { ...normalizedMedia[idx] };
                    for (const [k, v] of Object.entries(item)) {
                        if (v != null && v !== "") merged[k] = v; // valor real: gana
                        else if (!(k in merged)) merged[k] = v; // completa faltantes
                    }
                    normalizedMedia[idx] = merged;
                };

                // 1. rawMedia (puede venir vacío en contenido de suscripción).
                if (Array.isArray(post.rawMedia)) post.rawMedia.forEach((m) => mergeMedia(m));

                // 2. mediaItems del upstream: trae el id REAL del media aunque rawMedia
                //    venga vacío (clave para construir el espejo público /media-public).
                if (Array.isArray((post as any).mediaItems))
                    (post as any).mediaItems.forEach((m: any) => mergeMedia(m));

                // 3. post.media (objeto único, a veces sin id) — fusionar por tipo.
                if (post.media) {
                    const items = Array.isArray(post.media) ? post.media : [post.media];
                    items.forEach((mi) => mergeMedia(mi, true));
                }

                // 4. Enrich or add content.images
                if (post.content?.images && Array.isArray(post.content.images)) {
                    post.content.images.forEach((ci) => {
                        const existingIndex = normalizedMedia.findIndex(
                            (m) =>
                                (m.id && ci.id && m.id === ci.id) ||
                                (m.url && ci.url && m.url === ci.url) ||
                                ((m as any).image && (ci as any).image && (m as any).image === (ci as any).image) ||
                                (m.thumbnail && ci.thumbnail && m.thumbnail === ci.thumbnail),
                        );

                        if (existingIndex !== -1) {
                            normalizedMedia[existingIndex] = { ...normalizedMedia[existingIndex], ...ci };
                        } else {
                            normalizedMedia.push(ci);
                        }
                    });
                }

                // Estado real de acceso ANTES de forzar el desbloqueo de abajo. Se usa
                // sólo para el badge (Gratis / Subs / $X USD); el media se sigue
                // sirviendo desbloqueado vía el espejo media-public.
                const realPrice = Number((post as any).price) || 0;
                const isPremiumContent =
                    !!(post as any).isLocked ||
                    (post as any).locked === "yes" ||
                    (post as any).contentType === "Suscripción" ||
                    realPrice > 0;

                const enrichedPost = {
                    ...post,
                    creatorAvatar: user?.avatar ? replaceLegacyUrl(user.avatar) : null,
                    creatorName: user?.name || user?.username || "Usuario",
                    formattedDate: post.createdAt ? formatDate(post.createdAt) : null,
                    isPremiumContent,
                    realPrice,
                    isLocked: false,
                    locked: "no",
                    hasAccess: true,
                    isProtected: false,
                    isSubscribed: true,
                    isPurchased: true,
                    is_purchased: true,
                    hlsManifestUrl: post.hlsManifestUrl ? getProxiedUrl(post.hlsManifestUrl) : null,
                    mediaItems: normalizedMedia.map((m: any) => {
                        const mType = m.type || (m.image ? "image" : m.video ? "video" : "unknown");

                        const cleanField = (v: any) =>
                            typeof v === "string" && (v === "null" || v === "undefined" || v.trim() === "")
                                ? null
                                : v;
                        let baseVideoUrl =
                            cleanField(m.hlsManifestUrl) || cleanField(m.videoUrl) || cleanField(m.video);
                        let baseImageUrl = cleanField(m.url) || cleanField(m.image);

                        // Apply legacy URL replacement before proxy check
                        baseVideoUrl = replaceLegacyUrl(baseVideoUrl);
                        baseImageUrl = replaceLegacyUrl(baseImageUrl);

                        // Handle legacy filenames (non-URLs)
                        if (baseVideoUrl && !String(baseVideoUrl).startsWith("http")) {
                            const cleanPath = String(baseVideoUrl).replace(/^videos\//, "");
                            baseVideoUrl = `https://1796381938.rsc.cdn77.org/uploads/updates/videos/${cleanPath}`;
                        } else if (!baseVideoUrl && m.thumbnail) {
                            baseVideoUrl = String(m.thumbnail).replace("/thumbnail.jpg", "/hls/master.m3u8");
                        }

                        if (baseImageUrl && !String(baseImageUrl).startsWith("http")) {
                            baseImageUrl = `https://1796381938.rsc.cdn77.org/uploads/updates/images/${baseImageUrl}`;
                        } else if (!baseImageUrl && m.file_name && m.type === "image" && !m.requiresToken) {
                            baseImageUrl = `https://1796381938.rsc.cdn77.org/uploads/updates/images/${m.file_name}`;
                        }

                        const normalizedBaseVideoUrl = String(baseVideoUrl || "");
                        const videoMime = normalizedBaseVideoUrl.includes(".mp4")
                            ? "video/mp4"
                            : "application/x-mpegURL";

                        const isCdn77 = normalizedBaseVideoUrl.includes("cdn77.org");
                        const isLegacy = normalizedBaseVideoUrl.includes("legacy-cdn") || isCdn77;

                        const videoProxyUrl =
                            mType === "video" && post.id && m.id && user?.id && !isCdn77
                                ? `/api/ars/proxy?postId=${encodeURIComponent(String(post.id))}&mediaId=${encodeURIComponent(String(m.id))}&userId=${encodeURIComponent(String(user.id))}${baseVideoUrl ? `&url=${encodeURIComponent(String(baseVideoUrl))}` : ""}`
                                : null;

                        const finalImageUrl = baseImageUrl || m.url || m.image;
                        let finalThumbnailUrl =
                            m.thumbnail ||
                            (mType === "video"
                                ? `https://video-proxy.aroman-4f3.workers.dev/video/${user?.id}/${m.id}/thumbnail.jpg`
                                : null);

                        if (isLegacy && !m.thumbnail) {
                            finalThumbnailUrl = m.previewGif || null;
                        }

                        const thumbnailProxyUrl =
                            mType === "video" && post.id && m.id && user?.id && finalThumbnailUrl
                                ? `/api/ars/proxy?postId=${encodeURIComponent(String(post.id))}&mediaId=${encodeURIComponent(String(m.id))}&userId=${encodeURIComponent(String(user.id))}&url=${encodeURIComponent(String(finalThumbnailUrl))}`
                                : finalThumbnailUrl
                                    ? getProxiedUrl(finalThumbnailUrl)
                                    : null;

                        const isDeadPreviewGuess =
                            typeof m.previewGif === "string" &&
                            /\/video\/[^/]+\/[^/]+\/preview\.gif(\?|$)/i.test(m.previewGif);
                        let finalPreviewGifUrl = isDeadPreviewGuess ? null : m.previewGif || null;

                        const previewProxyUrl =
                            mType === "video" && post.id && m.id && user?.id && finalPreviewGifUrl
                                ? `/api/ars/proxy?postId=${encodeURIComponent(String(post.id))}&mediaId=${encodeURIComponent(String(m.id))}&userId=${encodeURIComponent(String(user.id))}&url=${encodeURIComponent(String(finalPreviewGifUrl))}`
                                : finalPreviewGifUrl
                                    ? getProxiedUrl(finalPreviewGifUrl)
                                    : null;

                        return {
                            ...m,
                            type: mType,
                            videoUrl: m.videoUrl ? replaceLegacyUrl(m.videoUrl) : m.videoUrl,
                            proxiedThumbnail:
                                thumbnailProxyUrl || (previewProxyUrl ? getProxiedUrl(previewProxyUrl) : null),
                            proxiedUrl: finalImageUrl ? getProxiedUrl(finalImageUrl) : null,
                            thumbnailUrl: thumbnailProxyUrl,
                            previewGifUrl: previewProxyUrl,
                            hlsManifestUrl: baseVideoUrl ? getProxiedUrl(baseVideoUrl) : null,
                            videoSource:
                                mType === "video" && baseVideoUrl
                                    ? videoProxyUrl || getProxiedUrl(baseVideoUrl)
                                    : null,
                            videoMime: mType === "video" ? videoMime : null,
                        };
                    }),
                };
                return enrichedPost;
            });

            // Local filtering as a fallback if the upstream API doesn't handle filtroMedia correctly
            if (filtroMedia !== "todos") {
                normalizedData.posts = normalizedData.posts.filter((post: any) => {
                    const mediaItems = post.mediaItems || [];
                    const postType = String(post.postType || "").toLowerCase();

                    if (filtroMedia === "fotos") {
                        return (
                            postType === "image" ||
                            postType === "photos" ||
                            postType === "mixed" ||
                            mediaItems.some((m: any) => m.type === "image" || m.type === "photos")
                        );
                    }
                    if (filtroMedia === "videos") {
                        return (
                            postType === "video" ||
                            postType === "mixed" ||
                            mediaItems.some((m: any) => m.type === "video")
                        );
                    }
                    return true;
                });

                if (normalizedData.total) {
                    normalizedData.total = normalizedData.posts.length;
                }
            }
        }

        return { ok: true, status: 200, data: normalizedData };
    } catch (error: any) {
        console.error(`❌ [fetchArsFeed] Error fetching feed for creator ${creatorId}:`, error);
        return { ok: false, status: 500, error: "Error interno al consultar Arsmate", details: error.message };
    }
}
