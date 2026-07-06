import { defineMiddleware } from "astro:middleware";

// Lógica de sesión + cache de Arsmate, extraída del middleware original de la app
// `arsmate` para vivir dentro de vs-ce3. El handler exportado (`arsMiddleware`)
// solo actúa sobre las rutas namespaced bajo `/ars` y `/api/ars/`; el resto de
// la app no se ve afectada (ver src/middleware.ts).

// Variable global para almacenar la cookie de sesión de Arsmate en el servidor.
// Esta cookie será compartida por todos los clientes que se conecten a este servidor.
let globalArsmateCookie: string | undefined = undefined;
let globalArsmateUserId: string | undefined = undefined;

// Env del runtime de Cloudflare (secrets/vars), capturado en cada request por el
// middleware. Se guarda a nivel de módulo para que loginArsmate/reloginArsmate
// puedan leer las credenciales sin recibir `context` (reloginArsmate se llama
// desde endpoints que no tienen acceso directo al env). En `astro dev` el
// adaptador lo rellena desde .dev.vars; en prod desde `wrangler secret put`.
let runtimeEnv: Env | undefined = undefined;

// Sistema simple de cache en memoria para las APIs de Arsmate
interface CacheEntry {
    body: any;
    status: number;
    headers: [string, string][];
    expiresAt: number;
}
const apiCache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos en milisegundos

// Prefijos de ruta gestionados por este middleware.
const ARS_PAGE_PREFIX = "/ars";
const ARS_API_PREFIX = "/api/ars/";

// Realiza el login en Arsmate y guarda la cookie en la global. Devuelve la cookie.
async function loginArsmate(): Promise<string | undefined> {
    const email = runtimeEnv?.ARSMATE_EMAIL;
    const password = runtimeEnv?.ARSMATE_PASSWORD;
    const baseUrl = "https://arsmate.com";

    if (!email || !password) {
        console.error(
            "❌ [ArsMiddleware] Faltan ARSMATE_EMAIL / ARSMATE_PASSWORD. " +
            "Configúralos con `wrangler secret put` (prod) o en .dev.vars (local).",
        );
        return globalArsmateCookie;
    }

    console.log(`🔑 [ArsMiddleware] Intentando login para: ${email}`);

    try {
        const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Origin": baseUrl,
                "Referer": `${baseUrl}/`,
                "Accept": "application/json"
            },
            body: JSON.stringify({ email, password }),
            redirect: "manual"
        });

        console.log(`[ArsMiddleware] Respuesta login: ${loginRes.status} ${loginRes.statusText}`);

        if (loginRes.ok) {
            const loginData = await loginRes.json() as any;

            if (loginData.user && loginData.user.id) {
                globalArsmateUserId = String(loginData.user.id);
            } else if (loginData.id) {
                globalArsmateUserId = String(loginData.id);
            }

            const setCookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [];
            if (setCookies.length === 0) {
                const raw = loginRes.headers.get('set-cookie');
                if (raw) setCookies.push(raw);
            }

            const authCookieMatch = setCookies.find(c => c.startsWith('ars_mate_auth='));
            if (authCookieMatch) {
                const authValue = authCookieMatch.split(';')[0].split('=')[1];
                globalArsmateCookie = `ars_mate_auth=${authValue}`;
                console.log("✅ [ArsMiddleware] Cookie ars_mate_auth guardada globalmente");
                return globalArsmateCookie;
            }
        } else {
            const errorText = await loginRes.text();
            console.error(`❌ [ArsMiddleware] Login falló (${loginRes.status}): ${errorText.slice(0, 200)}`);
        }
    } catch (error) {
        console.error("❌ [ArsMiddleware] Error durante el login:", error);
    }
    return globalArsmateCookie;
}

// Fuerza un re-login: la cookie almacenada puede expirar. El feed lo tolera como
// invitado, pero /api/ars/creators/search exige sesión válida y devuelve 500
// ("No autenticado"). Los endpoints que detecten ese caso pueden llamar a esto y
// reintentar con la cookie fresca.
export async function reloginArsmate(): Promise<string | undefined> {
    globalArsmateCookie = undefined;
    return await loginArsmate();
}

export const arsMiddleware = defineMiddleware(async (context, next) => {
    const { url, request } = context;

    // Solo gestionamos las rutas namespaced de Arsmate. El resto de la app sigue
    // su flujo normal sin login ni cache de Arsmate.
    const isArsPage = url.pathname === ARS_PAGE_PREFIX || url.pathname.startsWith(`${ARS_PAGE_PREFIX}/`);
    const isArsApi = url.pathname.startsWith(ARS_API_PREFIX);
    if (!isArsPage && !isArsApi) {
        return next();
    }

    // Capturamos el env del runtime de Cloudflare para que el login pueda leer
    // las credenciales (ver nota en la declaración de `runtimeEnv`).
    runtimeEnv = (context.locals as App.Locals).runtime?.env;

    // Si es una petición a la API de Arsmate, intentamos obtenerla del cache
    if (isArsApi && request.method === 'GET') {
        const cacheKey = url.toString();
        const cached = apiCache.get(cacheKey);

        if (cached && cached.expiresAt > Date.now()) {
            console.log(`🚀 [Cache] HIT: ${url.pathname}`);
            return new Response(JSON.stringify(cached.body), {
                status: cached.status,
                headers: {
                    ...Object.fromEntries(cached.headers),
                    'X-Cache': 'HIT',
                    'Content-Type': 'application/json'
                }
            });
        }
        console.log(`🔍 [Cache] MISS: ${url.pathname}`);
    }

    // Intentar obtener la cookie de la variable global
    let arsmateCookie = globalArsmateCookie;

    console.log(`[ArsMiddleware] Cookie global: ${arsmateCookie ? 'Encontrada' : 'No encontrada (requiere login)'}`);

    // Si no hay cookie global, realizamos el login
    if (!arsmateCookie) {
        arsmateCookie = await loginArsmate();
    }

    // Pasar la cookie a locals para que esté disponible en las rutas
    context.locals.arsmateCookie = arsmateCookie;
    context.locals.arsmateUserId = globalArsmateUserId;

    const response = await next();

    // Guardar en cache si la respuesta es exitosa y es una ruta de API de Arsmate
    if (isArsApi && request.method === 'GET' && response.status === 200) {
        const contentType = response.headers.get('Content-Type') || '';
        if (contentType.includes('application/json')) {
            try {
                const clonedResponse = response.clone();
                const body = await clonedResponse.json();
                const cacheKey = url.toString();

                const headerPairs: [string, string][] = [];
                response.headers.forEach((value, key) => headerPairs.push([key, value]));

                apiCache.set(cacheKey, {
                    body,
                    status: response.status,
                    headers: headerPairs,
                    expiresAt: Date.now() + CACHE_TTL
                });

                console.log(`💾 [Cache] Guardado: ${url.pathname}`);

                // Añadir header de cache a la respuesta original
                response.headers.set('X-Cache', 'MISS');
            } catch (error) {
                console.error(`❌ [Cache] Error guardando en cache ${url.pathname}:`, error);
            }
        }
    }

    return response;
});
