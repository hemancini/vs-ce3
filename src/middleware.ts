import { defineMiddleware } from "astro:middleware";
import { verifyToken, COOKIE_NAME } from "@/lib/auth";

/** Rutas que no requieren autenticación */
const PUBLIC_PREFIXES = ["/login", "/api/auth/"];

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = new URL(context.request.url);

  // Chrome DevTools solicita este archivo automáticamente ("Automatic Workspace
  // Folders"). No lo servimos: respondemos 204 para evitar el 404 en los logs.
  if (pathname === "/.well-known/appspecific/com.chrome.devtools.json") {
    return new Response(null, { status: 204 });
  }

  // En desarrollo no se valida la autenticación
  if (import.meta.env.DEV) {
    return next();
  }

  // Rutas públicas: login y endpoints de autenticación
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return next();
  }

  const token = context.cookies.get(COOKIE_NAME)?.value;
  const env = (context.locals as App.Locals).runtime?.env;
  const apiKey =
    env?.API_KEY ?? (import.meta.env.API_KEY as string | undefined) ?? "";

  if (!token || !apiKey || !(await verifyToken(token, apiKey))) {
    // Preservar la URL destino para redirigir después del login
    const loginUrl = new URL("/login", context.request.url);
    if (pathname !== "/" && pathname !== "/login") {
      loginUrl.searchParams.set("redirect", pathname);
    }
    return context.redirect(loginUrl.toString(), 302);
  }

  return next();
});
