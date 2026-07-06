import type { APIRoute } from "astro";
import { fetchArsFeed } from "@/lib/ars/feed";

export const GET: APIRoute = async ({ request, locals }) => {
  const arsmateCookie = locals.arsmateCookie;
  const arsmateUserId = locals.arsmateUserId;

  const searchParams = new URL(request.url).searchParams;

  const result = await fetchArsFeed(
    {
      creatorId: searchParams.get("creatorId"),
      limit: searchParams.get("limit") || undefined,
      page: searchParams.get("page") || undefined,
      contentFilter: searchParams.get("contentFilter") || undefined,
      ordenacion: searchParams.get("ordenacion") || undefined,
      filtroMedia: searchParams.get("filtroMedia") || undefined,
    },
    arsmateCookie,
    arsmateUserId,
  );

  if (!result.ok) {
    return new Response(
      JSON.stringify({ error: result.error, status: result.status, details: result.details }),
      { status: result.status, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(JSON.stringify(result.data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
