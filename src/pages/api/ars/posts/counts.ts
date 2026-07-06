import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals, request }) => {
    // const { username } = params;
    const arsmateCookie = locals.arsmateCookie;
    
    // We need creatorId. Usually it's passed or we have to resolve it.
    // The frontend can pass it as a query param.
    const url = new URL(request.url);
    const creatorId = url.searchParams.get('creatorId');

    if (!arsmateCookie) {
        return new Response(JSON.stringify({ 
            error: "No se pudo obtener la sesión de Arsmate." 
        }), { 
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    if (!creatorId) {
        return new Response(JSON.stringify({ 
            error: "creatorId is required" 
        }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const apiUrl = `https://arsmate.com/api/posts/contar-por-tipo?creatorId=${creatorId}`;

    try {
        const res = await fetch(apiUrl, {
            headers: {
                "Cookie": arsmateCookie,
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "application/json, text/plain, */*",
                "Origin": "https://arsmate.com",
                "Referer": "https://arsmate.com/"
            }
        });

        if (!res.ok) {
            return new Response(JSON.stringify({ 
                error: `Error de la API de Arsmate: ${res.status}`,
                status: res.status 
            }), { 
                status: res.status,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const data = await res.json();
        
        return new Response(JSON.stringify(data), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error(`❌ [API Proxy] Error fetching counts for ${creatorId}:`, error);
        return new Response(JSON.stringify({ error: "Error interno al consultar Arsmate" }), { 
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
