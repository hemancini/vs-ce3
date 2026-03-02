import type { APIRoute } from "astro";
import { getFirebaseToken, invalidateFirebaseToken } from "@/lib/vodscene/firebase-auth";

// ─── Caché en memoria ─────────────────────────────────────────────────────────
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas
const cache = new Map<string, { data: unknown; expiresAt: number }>();

// ─── Colecciones candidatas ────────────────────────────────────────────────────
const CANDIDATE_COLLECTIONS = [
  "videos", "users", "participants", "creators", "playlists",
  "purchases", "transactions", "sessions", "activeSessions",
  "subscriptions", "coupons", "earnings", "payouts",
  "notifications", "config", "settings", "categories", "tags",
  "comments", "reviews", "reports", "analytics", "events",
];

// ─── Firestore REST → JS plano ─────────────────────────────────────────────────
type FSValue = Record<string, unknown>;

function fsVal(v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  const o = v as FSValue;
  if ("stringValue"    in o) return o.stringValue;
  if ("integerValue"   in o) return parseInt(o.integerValue as string, 10);
  if ("doubleValue"    in o) return o.doubleValue;
  if ("booleanValue"   in o) return o.booleanValue;
  if ("nullValue"      in o) return null;
  if ("timestampValue" in o) return o.timestampValue;
  if ("mapValue"       in o) return fsFields((o.mapValue as FSValue).fields as FSValue || {});
  if ("arrayValue"     in o) return ((o.arrayValue as FSValue).values as unknown[] || []).map(fsVal);
  return v;
}

function fsFields(fields: FSValue): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(fields)) obj[k] = fsVal(val);
  return obj;
}

// ─── Helper fetch JSON ─────────────────────────────────────────────────────────
async function fetchJSON(url: string, options: RequestInit = {}) {
  const res  = await fetch(url, options);
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { ok: res.ok, status: res.status, statusText: res.statusText, json };
}

// ─── API handler ───────────────────────────────────────────────────────────────
export const GET: APIRoute = async ({ locals, url }) => {
  const env = (locals as App.Locals).runtime?.env;

  const FIREBASE_API_KEY = env?.FIREBASE_API_KEY ?? import.meta.env.FIREBASE_API_KEY;
  const FIREBASE_PROJECT = env?.FIREBASE_PROJECT ?? import.meta.env.FIREBASE_PROJECT;
  const EMAIL            = env?.VODSCENE_EMAIL    ?? import.meta.env.VODSCENE_EMAIL;
  const PASSWORD         = env?.VODSCENE_PASSWORD ?? import.meta.env.VODSCENE_PASSWORD;

  if (!FIREBASE_API_KEY || !EMAIL || !PASSWORD) {
    return new Response(JSON.stringify({ error: "Missing env vars" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Filtro de colección opcional: ?collection=videos  o  ?collections=videos,playlists
  const filterCol      = url.searchParams.get("collection")  ?? null;
  const filterCols     = url.searchParams.get("collections") ?? null; // lista separada por comas
  const forceRefresh   = url.searchParams.get("refresh") === "true";
  const collections    = filterCols
    ? CANDIDATE_COLLECTIONS.filter((c) => filterCols.split(",").map((s) => s.trim()).includes(c))
    : filterCol
      ? CANDIDATE_COLLECTIONS.filter((c) => c === filterCol)
      : CANDIDATE_COLLECTIONS;

  // Revisar caché antes de llamar a la API
  const cacheKey = filterCols ?? filterCol ?? "__all__";
  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return new Response(JSON.stringify(cached.data), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Cache": "HIT",
          "X-Cache-Expires-In": String(Math.round((cached.expiresAt - Date.now()) / 1000)) + "s",
        },
      });
    }
  }

  // 1. Obtener token (cacheado o nuevo login)
  let idToken: string;
  try {
    idToken = await getFirebaseToken({ apiKey: FIREBASE_API_KEY, email: EMAIL, password: PASSWORD });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Firebase login failed", detail: String(err) }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
  let fsHeaders = { "Authorization": `Bearer ${idToken}`, "Content-Type": "application/json" };

  // Helper: si Firestore devuelve 401, invalida el cache y renueva el token una vez
  async function refreshHeadersOnce(): Promise<boolean> {
    invalidateFirebaseToken();
    try {
      const fresh = await getFirebaseToken({ apiKey: FIREBASE_API_KEY, email: EMAIL, password: PASSWORD });
      fsHeaders = { "Authorization": `Bearer ${fresh}`, "Content-Type": "application/json" };
      return true;
    } catch {
      return false;
    }
  }

  // 2. Iterar colecciones
  const result: Record<string, Record<string, unknown>> = {};
  const meta: Record<string, { count: number; accessible: boolean; error?: string }> = {};

  for (const collectionId of collections) {
    // Probe (con un retry automático si el token expiró durante la request)
    let probe = await fetchJSON(`${FS_BASE}/${collectionId}?pageSize=1`, { headers: fsHeaders });
    if (probe.status === 401) {
      const renewed = await refreshHeadersOnce();
      if (renewed) {
        probe = await fetchJSON(`${FS_BASE}/${collectionId}?pageSize=1`, { headers: fsHeaders });
      }
    }

    if (probe.status === 401 || probe.status === 403) {
      meta[collectionId] = { count: 0, accessible: false, error: `${probe.status} Forbidden` };
      continue;
    }
    if (!probe.ok) {
      const notFound = (probe.json as FSValue)?.error && ((probe.json as FSValue).error as FSValue)?.status === "NOT_FOUND";
      meta[collectionId] = { count: 0, accessible: false, error: notFound ? "NOT_FOUND" : `${probe.status}` };
      continue;
    }

    // Accesible — paginar todos los documentos
    result[collectionId] = {};

    const processBody = (body: FSValue, pageToken: { value: string | null }) => {
      const docs = (body.documents as FSValue[]) || [];
      for (const doc of docs) {
        const id = (doc.name as string).split("/").pop()!;
        result[collectionId][id] = doc.fields ? fsFields(doc.fields as FSValue) : {};
      }
      pageToken.value    = (body.nextPageToken as string) || null;
    };

    const pt = { value: null as string | null };
    processBody(probe.json as FSValue, pt);

    while (pt.value) {
      const nextUrl = `${FS_BASE}/${collectionId}?pageSize=300&pageToken=${encodeURIComponent(pt.value)}`;
      const page    = await fetchJSON(nextUrl, { headers: fsHeaders });
      if (!page.ok) break;
      processBody(page.json as FSValue, pt);
    }

    const count = Object.keys(result[collectionId]).length;
    meta[collectionId] = { count, accessible: true };
  }

  // 3. Respuesta
  const totalDocs = Object.values(meta).reduce((s, m) => s + m.count, 0);
  const response = {
    meta: {
      totalCollections: Object.values(meta).filter((m) => m.accessible).length,
      totalDocuments:   totalDocs,
      collections:      meta,
    },
    data: result,
  };

  // Guardar en caché
  cache.set(cacheKey, { data: response, expiresAt: Date.now() + CACHE_TTL_MS });

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Cache": "MISS",
    },
  });
};
