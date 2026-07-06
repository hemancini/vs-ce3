import type { APIRoute } from 'astro';
import { fetchArsPost } from '@/lib/ars/posts';

export const GET: APIRoute = async ({ request, params, locals }) => {
    const { postId } = params;
    const { searchParams } = new URL(request.url);
    const creatorId = searchParams.get('creatorId');
    const arsmateCookie = locals.arsmateCookie;

    const result = await fetchArsPost(postId, creatorId, arsmateCookie);

    if (!result.ok) {
        return new Response(JSON.stringify({ error: result.error, status: result.status, details: result.details }), {
            status: result.status,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    return new Response(JSON.stringify(result.data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}
