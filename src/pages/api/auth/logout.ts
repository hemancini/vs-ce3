import type { APIRoute } from "astro";
import { COOKIE_NAME } from "@/lib/auth";

/** Limpia la cookie de sesión y redirige al login */
function clearCookieHeaders(): HeadersInit {
  return {
    // Sobreescribir la cookie con Max-Age=0 para borrarla
    "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
  };
}

export const POST: APIRoute = ({ redirect }) => {
  return new Response(null, {
    status: 302,
    headers: {
      ...clearCookieHeaders(),
      Location: "/login",
    },
  });
};

export const GET: APIRoute = ({ redirect }) => {
  return new Response(null, {
    status: 302,
    headers: {
      ...clearCookieHeaders(),
      Location: "/login",
    },
  });
};
