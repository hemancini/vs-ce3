import type { APIRoute } from 'astro';
import { fetchArsCreator } from '@/lib/ars/creators';

export const GET: APIRoute = async ({ params, locals }) => {
    const { username } = params;
    const arsmateCookie = locals.arsmateCookie;

    const result = await fetchArsCreator(username, arsmateCookie);

    if (!result.ok) {
        return new Response(JSON.stringify({ error: result.error, status: result.status }), {
            status: result.status,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    return new Response(JSON.stringify(result.data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}
