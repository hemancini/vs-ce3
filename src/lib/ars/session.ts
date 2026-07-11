import { defineMiddleware } from "astro:middleware";
import { loadArsSession, type ArsSession } from "./auth";

// Lógica de sesión + cache de Arsmate, extraída del middleware original de la app
// `arsmate` para vivir dentro de vs-ce3. El handler exportado (`arsMiddleware`)
// solo actúa sobre las rutas namespaced bajo `/ars` y `/api/ars/`; el resto de
// la app no se ve afectada (ver src/middleware.ts).

// Variable global para almacenar la cookie de sesión de Arsmate en el servidor.
// Esta cookie será compartida por todos los clientes que se conecten a este servidor.
let globalArsmateCookie: string | undefined = undefined;
let globalArsmateUserId: string | undefined = undefined;

// Env del runtime de Cloudflare (secrets/vars), capturado en cada request por el
// middleware. Se guarda a nivel de módulo para que reloginArsmate pueda releer
// la sesión de KV sin recibir `context` (se llama desde endpoints que no tienen
// acceso directo al env).
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
// Endpoint de autenticación: su respuesta refleja el estado de sesión en vivo, así
// que NUNCA debe cachearse (si no, tras iniciar sesión seguiría diciendo "Sin sesión").
const ARS_AUTH_ENDPOINT = "/api/ars/auth";
// Cookie de primera parte (por navegador) donde guardamos la sesión activa. Viaja
// con cada request, así que funciona igual en dev y en producción sin depender de
// memoria de módulo ni de la consistencia de KV entre requests.
const ARS_SESSION_COOKIE = "ars_session";

// Recarga la sesión guardada en KV (establecida desde la UI /api/ars/auth) y la
// refleja en las globales en memoria. Devuelve la cookie o undefined si no hay.
async function reloadFromStore(): Promise<string | undefined> {
    const stored = await loadArsSession(runtimeEnv);
    if (stored?.cookie) {
        globalArsmateCookie = stored.cookie;
        globalArsmateUserId = stored.userId;
        return globalArsmateCookie;
    }
    return undefined;
}

// Aplica en memoria una sesión establecida desde la UI (endpoint /api/ars/auth).
// Tiene prioridad sobre la cookie de entorno: al setearla, todas las peticiones
// siguientes la usan sin releer KV. La persistencia en KV la hace el endpoint.
export function setArsSession(session: ArsSession | null | undefined): void {
    if (session?.cookie) {
        globalArsmateCookie = session.cookie;
        if (session.userId) globalArsmateUserId = session.userId;
    }
}

// Olvida la sesión en memoria (p. ej. al cerrar sesión desde la UI). La próxima
// petición recargará desde KV (si el usuario ha guardado una).
export function clearArsSessionMemory(): void {
    globalArsmateCookie = undefined;
    globalArsmateUserId = undefined;
}

// Fuerza recargar la sesión: la cookie en memoria puede haber expirado. El feed
// lo tolera como invitado, pero /api/ars/creators/search exige sesión válida y
// devuelve 500 ("No autenticado"). Los endpoints que detecten ese caso llaman a
// esto para releer la sesión del usuario guardada en KV (mantenida desde el
// avatar de /ars) y reintentar. Ya NO se usan credenciales de entorno.
export async function reloginArsmate(): Promise<string | undefined> {
    globalArsmateCookie = undefined;
    globalArsmateUserId = undefined;
    return await reloadFromStore();
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

    // Capturamos el env del runtime de Cloudflare (para leer la sesión de KV).
    runtimeEnv = (context.locals as App.Locals).runtime?.env;

    // Sesión por navegador (cookie de primera parte): máxima prioridad. Es la que
    // fija el avatar al iniciar sesión y la que hace que funcione en dev.
    const browserSession = context.cookies.get(ARS_SESSION_COOKIE)?.value;

    // Respaldo compartido: sesión en memoria/KV (para SSR o clientes sin cookie).
    // En arranque en frío (sin cookie en memoria) la recuperamos de KV.
    if (!browserSession && !globalArsmateCookie) {
        await reloadFromStore();
    }

    // El endpoint de auth refleja el estado en vivo: nunca se sirve desde caché.
    const isAuthEndpoint = url.pathname === ARS_AUTH_ENDPOINT;

    // Si es una petición a la API de Arsmate (salvo auth), intentamos el cache.
    if (isArsApi && !isAuthEndpoint && request.method === 'GET') {
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

    // Cookie de la sesión activa: prioridad a la del navegador, luego la global.
    // Puede ser undefined: en ese caso las rutas responden como invitado / piden login.
    const arsmateCookie = browserSession || globalArsmateCookie;

    console.log(`[ArsMiddleware] Sesión: ${arsmateCookie ? (browserSession ? 'Cookie de navegador' : 'Global/KV') : 'Sin sesión (inicia sesión desde el avatar de /ars)'}`);

    // Pasar la cookie a locals para que esté disponible en las rutas
    context.locals.arsmateCookie = arsmateCookie;
    context.locals.arsmateUserId = globalArsmateUserId;

    const response = await next();

    // Guardar en cache si la respuesta es exitosa y es una ruta de API de Arsmate
    // (nunca el endpoint de auth: su estado debe leerse siempre en vivo).
    if (isArsApi && !isAuthEndpoint && request.method === 'GET' && response.status === 200) {
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
