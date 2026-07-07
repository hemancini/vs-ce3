import type { APIRoute } from 'astro';
import { getProxiedUrl } from '@/utils/ars/proxy';

// Proxy de comentarios de un post de Arsmate. Usa la sesión global del
// middleware (cookie + userId) para que la API devuelva isLiked correcto.
// La respuesta pasa por el cache de 5 min del arsMiddleware como el resto
// de /api/ars/*.

const LEGACY_AVATAR_BASE = 'https://1796381938.rsc.cdn77.org/uploads/avatar/';

// Los avatares de comentarios vienen o como URL completa (worker /profile/)
// o como filename pelado del CDN legacy de avatares.
function resolveAvatar(avatar: unknown): string | null {
    if (!avatar || typeof avatar !== 'string') return null;
    const s = avatar.trim();
    if (!s) return null;
    // El default.jpg de Arsmate es un ícono claro que rompe el modo oscuro:
    // lo tratamos como "sin avatar" para que el cliente muestre la inicial.
    if (/(^|\/)default\.jpe?g$/i.test(s)) return null;
    if (s.includes('://')) return getProxiedUrl(s) || null;
    return getProxiedUrl(LEGACY_AVATAR_BASE + s) || null;
}

export const GET: APIRoute = async ({ request, params, locals }) => {
    const { postId } = params;
    const { searchParams } = new URL(request.url);
    const page = Number(searchParams.get('page')) || 1;
    const limit = Math.min(Number(searchParams.get('limit')) || 10, 50);
    const cookie = locals.arsmateCookie;
    const userId = locals.arsmateUserId;

    const json = (body: any, status = 200) =>
        new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });

    if (!postId) return json({ error: 'postId es requerido' }, 400);
    if (!cookie) return json({ error: 'No se pudo obtener la sesión de Arsmate.' }, 401);

    const apiUrl =
        `https://arsmate.com/api/posts/${encodeURIComponent(postId)}/comments` +
        `?page=${page}&limit=${limit}${userId ? `&userId=${encodeURIComponent(userId)}` : ''}`;

    // La web de Arsmate manda el token de sesión también como header.
    const sessionToken = cookie.match(/ars_mate_auth=([^;]+)/)?.[1];

    try {
        const res = await fetch(apiUrl, {
            headers: {
                Cookie: cookie,
                ...(sessionToken ? { 'x-session-token': sessionToken } : {}),
                'User-Agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Accept: 'application/json, text/plain, */*',
                Origin: 'https://arsmate.com',
                Referer: 'https://arsmate.com/',
            },
        });

        if (!res.ok) {
            return json({ error: `Error de la API de Arsmate: ${res.status}` }, res.status);
        }

        const data: any = await res.json();

        if (Array.isArray(data?.comments)) {
            data.comments = data.comments.map((c: any) => ({
                ...c,
                user: c?.user
                    ? { ...c.user, avatarUrl: resolveAvatar(c.user.avatar) }
                    : c?.user,
            }));
        }

        return json(data);
    } catch (error: any) {
        console.error(`❌ [comments] Error fetching comments del post ${postId}:`, error);
        return json({ error: 'Error interno al consultar Arsmate', details: error.message }, 500);
    }
};
