import type { APIRoute } from 'astro';
import type { ArsmateCreator, ArsmateCreatorStats, ArsmateSearchResponse } from '@/types/arsmate';
import { reloginArsmate } from '@/lib/ars/session';

const UPSTREAM = 'https://arsmate.com/api/creators/search';
const UPSTREAM_PAGE_SIZE = 50; // El upstream tope cada página a 50 resultados.

// La API de Arsmate ignora `sort`/`order`: siempre devuelve el mismo orden fijo.
// Para soportar ordenamiento real hay que traer toda la lista y ordenarla aquí.
// Mapea el `sort` del frontend al campo numérico de stats correspondiente.
const SORT_FIELD_MAP: Record<string, keyof ArsmateCreatorStats> = {
    followers: 'subscribers',
    subscribers: 'subscribers',
    likes: 'likes',
    posts: 'posts',
};

// El catálogo de Arsmate tiene ~140.000 creadores y la API NO ordena (devuelve
// siempre el mismo orden por recencia). Traerlo entero para ordenar globalmente
// es inviable, así que ordenamos un POOL acotado: las primeras N páginas del
// catálogo. Cubre de sobra el scroll que un usuario recorre en una vista ordenada.
// Subir POOL_PAGES amplía el orden a costa de más requests al upstream en frío.
const POOL_PAGES = 12;                       // 12 × 50 = 600 creadores ordenables

// Caché en memoria del pool de creadores (sin ordenar). Se comparte entre todas
// las peticiones de páginas/ordenamientos para no recorrer el upstream en cada
// scroll. El middleware además cachea cada página ya calculada.
const POOL_TTL = 5 * 60 * 1000;
let poolCache: { creators: ArsmateCreator[]; expiresAt: number } | null = null;

function buildHeaders(cookie: string): HeadersInit {
    return {
        "Cookie": cookie,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://arsmate.com",
        "Referer": "https://arsmate.com/",
    };
}

function statNumber(value: number | string | null | undefined): number {
    const n = typeof value === 'string' ? parseFloat(value) : value;
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

// Trae el pool acotado (primeras POOL_PAGES páginas) del upstream. Valida la
// cookie con la página 1 (con re-login si hace falta) y luego trae el resto en
// paralelo. OJO: el `hasMore` del upstream NO es fiable (devuelve false en
// cualquier página con <50 items, no solo al final), así que NO lo usamos como
// señal de fin; traemos un número fijo de páginas y descartamos fallos puntuales.
async function fetchCreatorPool(initialCookie: string): Promise<ArsmateCreator[]> {
    if (poolCache && poolCache.expiresAt > Date.now()) {
        return poolCache.creators;
    }

    const fetchPage = (cookie: string, page: number) => fetch(
        `${UPSTREAM}?page=${page}&limit=${UPSTREAM_PAGE_SIZE}`,
        { headers: buildHeaders(cookie) }
    );

    // Trae una página con un reintento ante fallos transitorios (el upstream puede
    // devolver errores esporádicos bajo varias peticiones en paralelo).
    const fetchPageCreators = async (cookie: string, page: number): Promise<ArsmateCreator[] | null> => {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const r = await fetchPage(cookie, page);
                if (r.ok) {
                    const data = (await r.json()) as ArsmateSearchResponse;
                    return data.creators ?? [];
                }
            } catch {
                // reintentar
            }
        }
        return null;
    };

    // Página 1: aquí resolvemos una cookie válida para reutilizarla en el resto.
    let cookie = initialCookie;
    let res = await fetchPage(cookie, 1);
    if (res.status === 401 || res.status === 500) {
        const fresh = await reloginArsmate();
        if (fresh) {
            cookie = fresh;
            res = await fetchPage(cookie, 1);
        }
    }
    if (!res.ok) {
        throw new Error(`Upstream ${res.status}`);
    }

    const first: ArsmateSearchResponse = await res.json();
    const pages: (ArsmateCreator[] | null)[] = [first.creators ?? []];

    // Resto de páginas (2..POOL_PAGES) en paralelo, conservando el orden de página.
    const rest = Array.from({ length: POOL_PAGES - 1 }, (_, i) => i + 2);
    const restResults = await Promise.all(rest.map((p) => fetchPageCreators(cookie, p)));
    pages.push(...restResults);

    const all: ArsmateCreator[] = [];
    for (const creators of pages) {
        if (creators && creators.length) all.push(...creators);
    }

    poolCache = { creators: all, expiresAt: Date.now() + POOL_TTL };
    return all;
}

export const GET: APIRoute = async ({ request, locals }) => {
    const arsmateCookie = locals.arsmateCookie;

    if (!arsmateCookie) {
        return new Response(JSON.stringify({
            error: "No se pudo obtener la sesión de Arsmate."
        }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const url = new URL(request.url);
    const searchParams = new URLSearchParams(url.search);

    // Official Arsmate search parm is 'q'
    if (searchParams.has('search')) {
        const query = searchParams.get('search');
        searchParams.delete('search');
        if (query) searchParams.set('q', query);
    }

    if (searchParams.get('q') === '') {
        searchParams.delete('q');
    }

    const query = searchParams.get('q');
    const sort = searchParams.get('sort');
    const sortField = sort ? SORT_FIELD_MAP[sort] : undefined;

    // Ruta ordenada: solo cuando NO hay búsqueda de texto y el sort es conocido.
    // El upstream no ordena, así que traemos el pool, lo ordenamos y paginamos aquí.
    if (!query && sortField) {
        const order = searchParams.get('order') === 'asc' ? 'asc' : 'desc';
        const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
        const limit = Math.max(1, parseInt(searchParams.get('limit') || '40', 10) || 40);

        try {
            const all = await fetchCreatorPool(arsmateCookie);

            const sorted = [...all].sort((a, b) => {
                const av = statNumber(a.stats?.[sortField]);
                const bv = statNumber(b.stats?.[sortField]);
                return order === 'asc' ? av - bv : bv - av;
            });

            const start = (page - 1) * limit;
            const pageItems = sorted.slice(start, start + limit);
            const hasMore = start + limit < sorted.length;

            const body: ArsmateSearchResponse = {
                success: true,
                creators: pageItems,
                total: sorted.length,
                page,
                limit,
                hasMore,
            };

            return new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error: any) {
            console.error("❌ [API Proxy] Error sorting creators:", error);
            return new Response(JSON.stringify({ error: "Error interno al consultar Arsmate" }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    // Ruta passthrough: búsqueda de texto u otros parámetros que el upstream sí maneja.
    const queryString = searchParams.toString();
    const apiUrl = `${UPSTREAM}${queryString ? `?${queryString}` : ''}`;

    try {
        const doFetch = (cookie: string) => fetch(apiUrl, { headers: buildHeaders(cookie) });

        let res = await doFetch(arsmateCookie);

        // La cookie global puede expirar: search exige sesión válida y devuelve
        // 500 "No autenticado". Renovamos la sesión y reintentamos una vez.
        if (res.status === 401 || res.status === 500) {
            const fresh = await reloginArsmate();
            if (fresh) res = await doFetch(fresh);
        }

        if (!res.ok) {
            return new Response(JSON.stringify({
                error: `Error de la API de Arsmate: ${res.status}`,
                status: res.status
            }), {
                status: res.status,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const data: ArsmateSearchResponse = await res.json();

        return new Response(JSON.stringify(data), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error: any) {
        console.error("❌ [API Proxy] Error searching creators:", error);
        return new Response(JSON.stringify({ error: "Error interno al consultar Arsmate" }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
