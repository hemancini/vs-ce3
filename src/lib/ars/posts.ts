import { getProxiedUrl, formatDate, replaceLegacyUrl } from "@/utils/ars/proxy";
import type { ArsmateFeedResponse, ArsmatePost, ArsmateMedia } from "@/types/arsmate";
import { fillMediaPathsFromFeeds } from "@/utils/ars/media-fallback";
import { normalizeArsLegacyUrls } from "@/lib/ars/creators";

// Servicio compartido para obtener un post de Arsmate (con todo el enriquecimiento
// de media). Igual que fetchArsCreator, se llama DIRECTAMENTE desde el SSR de las
// páginas y desde el endpoint /api/ars/posts/[postId], evitando el loopback HTTP
// hacia el propio hostname que en Cloudflare Pages devuelve el HTML de la SPA.
// Ver nota en src/lib/ars/creators.ts.

export interface FetchPostResult {
    ok: boolean;
    status: number;
    data?: ArsmateFeedResponse;
    error?: string;
    details?: string;
}

const ARS_FETCH_HEADERS = (cookie: string) => ({
    Cookie: cookie,
    "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    Origin: "https://arsmate.com",
    Referer: "https://arsmate.com/",
});

export async function fetchArsPost(
    postId: string | undefined,
    creatorId: string | null | undefined,
    cookie: string | undefined,
): Promise<FetchPostResult> {
    if (!cookie) {
        return { ok: false, status: 401, error: "No se pudo obtener la sesión de Arsmate." };
    }
    if (!postId) {
        return { ok: false, status: 400, error: "postId es requerido" };
    }

    // creatorId es opcional: la API de Arsmate resuelve el post solo con postId
    // (devuelve también su autor). Lo incluimos cuando lo tenemos para acotar.
    const apiUrl = creatorId
        ? `https://arsmate.com/api/posts/feed?creatorId=${creatorId}&postId=${postId}`
        : `https://arsmate.com/api/posts/feed?postId=${postId}`;

    try {
        const res = await fetch(apiUrl, { headers: ARS_FETCH_HEADERS(cookie) });

        if (!res.ok) {
            return { ok: false, status: res.status, error: `Error de la API de Arsmate: ${res.status}` };
        }

        const data: ArsmateFeedResponse = await res.json();

        // 1. Normalización de URLs en TODO el objeto de datos antes de cualquier procesamiento
        const normalizedData: ArsmateFeedResponse = JSON.parse(
            normalizeArsLegacyUrls(JSON.stringify(data)),
        );

        // Completa la ruta de media gateada (imágenes y videos) desde los JSON capturados (ver media-fallback).
        if (normalizedData.success && Array.isArray(normalizedData.posts)) {
            await fillMediaPathsFromFeeds(normalizedData.posts as any[]);
        }

        // Enrich data with formats expected by the frontend (V1 parity)
        if (normalizedData.success && Array.isArray(normalizedData.posts) && normalizedData.posts.length > 0) {
            const post: ArsmatePost = normalizedData.posts[0];
            const user = post.author || post.user;

            // --- ROBUST MEDIA NORMALIZATION ---
            const normalizedMedia: ArsmateMedia[] = [];

            // Fusiona un media en la lista, sin pisar valores reales con null/''.
            // matchByType: para objetos sin id (p.ej. post.media en contenido de
            // suscripción) los unimos al item del mismo tipo en vez de duplicar.
            const mergeMedia = (item: any, matchByType = false) => {
                if (!item) return;
                const itemType = item.type || (item.video ? 'video' : (item.image ? 'image' : undefined));
                let idx = item.id != null ? normalizedMedia.findIndex(m => m.id === item.id) : -1;
                if (idx === -1 && matchByType && item.id == null && itemType) {
                    idx = normalizedMedia.findIndex((m: any) => (m.type || (m.video ? 'video' : 'image')) === itemType);
                }
                if (idx === -1) {
                    normalizedMedia.push({ ...item });
                    return;
                }
                const merged: any = { ...normalizedMedia[idx] };
                for (const [k, v] of Object.entries(item)) {
                    if (v != null && v !== '') merged[k] = v;       // valor real: gana
                    else if (!(k in merged)) merged[k] = v;          // completa faltantes
                }
                normalizedMedia[idx] = merged;
            };

            // 1. rawMedia (puede venir vacío en contenido de suscripción).
            if (Array.isArray(post.rawMedia)) post.rawMedia.forEach(m => mergeMedia(m));

            // 2. mediaItems del upstream: trae el id REAL del media aunque rawMedia
            //    venga vacío (clave para construir el espejo público /media-public).
            if (Array.isArray((post as any).mediaItems)) (post as any).mediaItems.forEach((m: any) => mergeMedia(m));

            // 3. post.media (objeto único, a veces sin id) — fusionar por tipo.
            if (post.media) {
                const items = Array.isArray(post.media) ? post.media : [post.media];
                items.forEach(mi => mergeMedia(mi, true));
            }

            // 4. content.images.
            if (post.content?.images && Array.isArray(post.content.images)) {
                post.content.images.forEach(ci => mergeMedia(ci));
            }

            // Estado real de acceso ANTES de forzar el desbloqueo. Se usa sólo
            // para el badge (Gratis / Subs / $X USD); el media se sigue sirviendo
            // desbloqueado vía el espejo media-public.
            const realPrice = Number((post as any).price) || 0;
            const isPremiumContent =
                !!(post as any).isLocked ||
                (post as any).locked === 'yes' ||
                (post as any).contentType === 'Suscripción' ||
                realPrice > 0;

            const enrichedPost = {
                ...post,
                creatorAvatar: user?.avatar ? getProxiedUrl(user.avatar) : null,
                creatorName: user?.name || user?.username || 'Usuario',
                formattedDate: post.createdAt ? formatDate(post.createdAt) : null,
                isPremiumContent,
                realPrice,
                // Desbloqueo: forzamos acceso para que PostCard muestre el player
                // (servido por el espejo media-public, que no exige token) en vez
                // del candado. Mismo criterio que el feed para que el detalle sea
                // consistente. El PPV/imagen legacy sin URL real cae al overlay
                // "Contenido Exclusivo" porque su videoSource/proxiedUrl es null.
                isLocked: false,
                locked: 'no',
                hasAccess: true,
                isProtected: false,
                isSubscribed: true,
                isPurchased: true,
                is_purchased: true,
                hlsManifestUrl: post.hlsManifestUrl ? getProxiedUrl(post.hlsManifestUrl) : null,
                mediaItems: normalizedMedia.map((m: any) => {
                    const mType = m.type || (m.image ? 'image' : (m.video ? 'video' : 'unknown'));
                    // Arsmate a veces devuelve el string literal "null"/"undefined";
                    // lo tratamos como vacío para no construir URLs basura (.../videos/null).
                    const cleanField = (v: any) =>
                      typeof v === 'string' && (v === 'null' || v === 'undefined' || v.trim() === '') ? null : v;
                    let baseVideoUrl = cleanField(m.hlsManifestUrl) || cleanField(m.videoUrl) || cleanField(m.video);

                    // Handle legacy video filenames (non-URLs)
                    if (baseVideoUrl && !baseVideoUrl.startsWith('http')) {
                        // Limpiar el prefijo "videos/" si ya viene en el path para evitar duplicación
                        const cleanPath = String(baseVideoUrl).replace(/^videos\//, '');
                        baseVideoUrl = `https://1796381938.rsc.cdn77.org/uploads/updates/videos/${cleanPath}`;
                    } else if (!baseVideoUrl && m.thumbnail) {
                         baseVideoUrl = String(m.thumbnail).replace('/thumbnail.jpg', '/hls/master.m3u8');
                    }

                    let baseImageUrl = m.url || m.image;
                    if (baseImageUrl && !String(baseImageUrl).startsWith('http')) {
                        baseImageUrl = `https://1796381938.rsc.cdn77.org/uploads/updates/images/${baseImageUrl}`;
                    } else if (!baseImageUrl && m.file_name && m.type === 'image' && !m.requiresToken) {
                        // file_name es el nombre original de subida (IMG_xxx.jpeg), no la
                        // ruta real en el CDN (un hash). Para contenido gateado
                        // (requiresToken) ese guess da 404; sin URL real dejamos
                        // proxiedUrl en null para que PostCard caiga al overlay
                        // "Contenido Exclusivo" (mismo criterio que feed.ts).
                        baseImageUrl = `https://1796381938.rsc.cdn77.org/uploads/updates/images/${m.file_name}`;
                    }

                    // Apply legacy URL replacement before proxy check
                    baseVideoUrl = replaceLegacyUrl(baseVideoUrl);
                    baseImageUrl = replaceLegacyUrl(baseImageUrl);

                    const normalizedBaseVideoUrl = String(baseVideoUrl || '');
                    const videoMime = normalizedBaseVideoUrl.includes('.mp4') ? 'video/mp4' : 'application/x-mpegURL';

                    // Proxy for video content if needed
                    const isCdn77 = normalizedBaseVideoUrl.includes('cdn77.org');
                    const videoProxyUrl = mType === 'video' && post.id && m.id && user?.id && !isCdn77
                        ? `/api/ars/proxy?postId=${encodeURIComponent(String(post.id))}&mediaId=${encodeURIComponent(String(m.id))}&userId=${encodeURIComponent(String(user.id))}${baseVideoUrl ? `&url=${encodeURIComponent(String(baseVideoUrl))}` : ''}`
                        : null;

                    const finalImageUrl = baseImageUrl || m.url || m.image;
                    let finalThumbnailUrl = m.thumbnail || (mType === 'video' ? `https://video-proxy.aroman-4f3.workers.dev/video/${user?.id}/${m.id}/thumbnail.jpg` : null);

                    // If it's a legacy video and we don't have a thumbnail, try to use a gif or don't set a thumbnail that will 404
                    const isLegacy = normalizedBaseVideoUrl.includes('legacy-cdn') || normalizedBaseVideoUrl.includes('cdn77.org');
                    if (isLegacy && !m.thumbnail) {
                        finalThumbnailUrl = m.previewGif || null;
                    }

                    // Robust Proxying for Thumbnails
                    const thumbnailProxyUrl = mType === 'video' && post.id && m.id && user?.id && finalThumbnailUrl
                        ? `/api/ars/proxy?postId=${encodeURIComponent(String(post.id))}&mediaId=${encodeURIComponent(String(m.id))}&userId=${encodeURIComponent(String(user.id))}&url=${encodeURIComponent(String(finalThumbnailUrl))}`
                        : (finalThumbnailUrl ? getProxiedUrl(finalThumbnailUrl) : null);

                    // Previews for modern content.
                    // El /video/<u>/<m>/preview.gif (lo devuelva Arsmate o lo
                    // construyamos) no existe en el CDN (404). Lo descartamos;
                    // PostCard cae al thumbnail estático.
                    const isDeadPreviewGuess = typeof m.previewGif === 'string' && /\/video\/[^/]+\/[^/]+\/preview\.gif(\?|$)/i.test(m.previewGif);
                    let finalPreviewGifUrl = isDeadPreviewGuess ? null : (m.previewGif || null);
                    const previewProxyUrl = mType === 'video' && post.id && m.id && user?.id && finalPreviewGifUrl
                        ? `/api/ars/proxy?postId=${encodeURIComponent(String(post.id))}&mediaId=${encodeURIComponent(String(m.id))}&userId=${encodeURIComponent(String(user.id))}&url=${encodeURIComponent(String(finalPreviewGifUrl))}`
                        : (finalPreviewGifUrl ? getProxiedUrl(finalPreviewGifUrl) : null);

                    return {
                        ...m,
                        type: mType,
                        proxiedThumbnail: thumbnailProxyUrl || (previewProxyUrl ? getProxiedUrl(previewProxyUrl) : null),
                        proxiedUrl: finalImageUrl ? getProxiedUrl(finalImageUrl) : null,
                        thumbnailUrl: thumbnailProxyUrl,
                        previewGifUrl: previewProxyUrl,
                        hlsManifestUrl: baseVideoUrl ? getProxiedUrl(baseVideoUrl) : null,
                        videoSource: mType === 'video' ? (videoProxyUrl || (baseVideoUrl ? getProxiedUrl(baseVideoUrl) : null)) : null,
                        videoMime: mType === 'video' ? videoMime : null
                    };
                })
            };
            (normalizedData as any).post = enrichedPost;
        }

        return { ok: true, status: 200, data: normalizedData };
    } catch (error: any) {
        console.error(`❌ [fetchArsPost] Error fetching post ${postId}:`, error);
        return { ok: false, status: 500, error: "Error interno al consultar Arsmate", details: error.message };
    }
}
