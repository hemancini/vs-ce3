import type { ArsmateCreatorResponse } from "@/types/arsmate";

// Servicio compartido para obtener un creador de Arsmate.
//
// IMPORTANTE: este helper se llama DIRECTAMENTE desde el SSR de las páginas
// (.astro) y desde el endpoint /api/ars/creators/[username]. En Cloudflare Pages
// un `fetch()` server-side hacia el propio hostname NO vuelve a entrar de forma
// fiable en las Functions/middleware: lo resuelve el handler de assets estáticos
// y devuelve el HTML de fallback de la SPA (`<!DOCTYPE html>`), lo que rompía el
// `response.json()` del SSR. Llamando a esta función evitamos el loopback HTTP.

export interface FetchCreatorResult {
    ok: boolean;
    status: number;
    data?: ArsmateCreatorResponse;
    error?: string;
}

const ARS_FETCH_HEADERS = (cookie: string) => ({
    Cookie: cookie,
    "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    Origin: "https://arsmate.com",
    Referer: "https://arsmate.com/",
});

// Normaliza las URLs legacy (worker viejo -> CDN77) sobre el JSON serializado.
// Misma lógica usada en los endpoints de posts para mantener paridad.
export function normalizeArsLegacyUrls(jsonString: string): string {
    let out = jsonString
        .replace(/https:\/\/video-proxy\.aroman-4f3\.workers\.dev\/legacy-cdn\/avatar\//g, "https://1796381938.rsc.cdn77.org/uploads/avatar/")
        .replace(/https:\/\/video-proxy\.aroman-4f3\.workers\.dev\/legacy-cdn\/cover\//g, "https://1796381938.rsc.cdn77.org/uploads/cover/")
        .replace(/https:\/\/video-proxy\.aroman-4f3\.workers\.dev\/legacy-cdn\/messages\//g, "https://1796381938.rsc.cdn77.org/uploads/messages/");

    const legacyWorkerBase = "https://video-proxy\\.aroman-4f3\\.workers\\.dev/legacy-cdn";
    const cdnBase = "https://1796381938.rsc.cdn77.org/uploads";

    out = out.replace(
        new RegExp(`${legacyWorkerBase}/(videos|images|posts)/([^"]+)`, "g"),
        (match, type, path) => {
            if (path.includes("thumbnail.jpg")) return match;
            const folder = type === "videos" ? "updates/videos" : "updates/images";
            return `${cdnBase}/${folder}/${path}`;
        },
    );

    return out;
}

export async function fetchArsCreator(
    username: string | undefined,
    cookie: string | undefined,
): Promise<FetchCreatorResult> {
    if (!cookie) {
        return { ok: false, status: 401, error: "No se pudo obtener la sesión de Arsmate." };
    }
    if (!username) {
        return { ok: false, status: 400, error: "Username es requerido" };
    }

    try {
        const res = await fetch(`https://arsmate.com/api/creators/${username}`, {
            headers: ARS_FETCH_HEADERS(cookie),
        });

        if (!res.ok) {
            return { ok: false, status: res.status, error: `Error de la API de Arsmate: ${res.status}` };
        }

        const data: ArsmateCreatorResponse = await res.json();
        const normalizedData = JSON.parse(
            normalizeArsLegacyUrls(JSON.stringify(data)),
        ) as ArsmateCreatorResponse;

        return { ok: true, status: 200, data: normalizedData };
    } catch (error: any) {
        console.error(`❌ [fetchArsCreator] Error fetching creator ${username}:`, error);
        return { ok: false, status: 500, error: "Error interno al consultar Arsmate" };
    }
}
