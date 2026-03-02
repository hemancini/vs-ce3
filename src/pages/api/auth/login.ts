import type { APIRoute } from "astro";
import { signToken, COOKIE_NAME, SESSION_MAX_MS } from "@/lib/auth";

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const env = (locals as App.Locals).runtime?.env;
  const apiKey =
    env?.API_KEY ?? (import.meta.env.API_KEY as string | undefined) ?? "";

  // Leer cuerpo del formulario (una sola vez)
  let provided = "";
  let redirectTo = "/";
  try {
    const form = await request.formData();
    provided   = (form.get("apiKey")   as string | null) ?? "";
    redirectTo = (form.get("redirect") as string | null) ?? "/";
    // Asegurarse de que solo sean paths relativos (protección open-redirect)
    if (!redirectTo.startsWith("/") || redirectTo.startsWith("//")) {
      redirectTo = "/";
    }
  } catch {
    return redirect("/login?error=1", 302);
  }

  // --- Validar contraseña ---
  if (!apiKey || provided !== apiKey) {
    // Pequeño delay para dificultar ataques de temporización
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 200));
    return redirect("/login?error=1", 302);
  }

  // Generar token firmado
  const token = await signToken(apiKey);

  // Calcular timestamp de expiración para sessionStorage del cliente
  const expiryMs = Date.now() + SESSION_MAX_MS;

  // Serializar redirectTo como JSON para evitar inyecciones en el script
  const redirectToJson = JSON.stringify(redirectTo);

  // Responder con HTML que configura sessionStorage y luego redirige
  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Accediendo…</title></head>
<body>
<script>
  try {
    sessionStorage.setItem('vs_session_expiry', '${expiryMs}');
  } catch (e) { /* por si sessionStorage no está disponible */ }
  window.location.replace(${redirectToJson});
</script>
<noscript>
  <meta http-equiv="refresh" content="0;url=${redirectTo}" />
</noscript>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Cookie HttpOnly + SameSite=Strict + sin Max-Age → muere al cerrar el navegador
      // El servidor también valida la expiración embebida en el token
      "Set-Cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict`,
    },
  });
};

// Rechazar GET directo
export const GET: APIRoute = ({ redirect }) => redirect("/login", 302);
