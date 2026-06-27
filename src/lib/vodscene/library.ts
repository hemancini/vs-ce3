// src/lib/vodscene/library.ts
//
// "Modo de lectura" de vodscene, análogo al de Sheer. El catálogo de
// /vodscene normalmente se lee EN VIVO desde Firestore (requiere la cuenta
// activa de Firebase). Este módulo permite, además, guardar un SNAPSHOT del
// catálogo en KV (`vs:library`) y leerlo sin autenticación:
//
//   · 'live'  → /vodscene llama a /api/vodscene/firestore en cada request.
//   · 'saved' → /vodscene lee la biblioteca cifrada de KV (sin Firebase).
//
// El snapshot es la respuesta cruda del endpoint de Firestore ({ meta, data }) más
// metadatos, así que la página lo consume con el mismo código. Se persiste
// minificado + cifrado (AES-256-GCM) reutilizando el helper de Sheer; si supera
// 5 MB se reparte en trozos `vs:library:chunk:N`.

import {
  decryptJSON,
  encryptString,
  encryptBytes,
  decryptBytes,
} from "../sheer/crypto.js";

const KV_LIBRARY = "vs:library";
const KV_MODE = "vodscene:mode";

// Reutilizamos el secreto de Sheer; VODSCENE_KV_SECRET lo sobrescribe si existe.
const resolveSecret = (env: any): string | undefined =>
  env?.VODSCENE_KV_SECRET ||
  env?.SHEER_KV_SECRET ||
  (typeof process !== "undefined"
    ? process.env?.VODSCENE_KV_SECRET || process.env?.SHEER_KV_SECRET
    : undefined);

// ── Tipos ─────────────────────────────────────────────────────────────────────
export interface FirestoreResponse {
  meta: {
    totalCollections: number;
    totalDocuments: number;
    collections: Record<string, { count: number; accessible: boolean; error?: string }>;
  };
  data: Record<string, Record<string, Record<string, unknown>>>;
}

export interface VodsceneLibrary {
  generatedAt: number;
  totalVideos: number;
  totalPlaylists: number;
  response: FirestoreResponse;
}

// ── Modo de lectura (live ↔ saved) ───────────────────────────────────────────
/** Modo de lectura actual ('live' | 'saved'). Default 'live'. */
export async function loadMode(env: any): Promise<"live" | "saved"> {
  try {
    const raw = await env?.VS_C3_KV?.get(KV_MODE);
    if (raw === "saved" || raw === "live") return raw;
  } catch {
    // KV ilegible: caemos al default.
  }
  return "live";
}

/** Persiste el modo de lectura. Devuelve el modo normalizado. */
export async function saveMode(mode: unknown, env: any): Promise<"live" | "saved"> {
  const m = mode === "saved" ? "saved" : "live";
  try {
    if (env?.VS_C3_KV) await env.VS_C3_KV.put(KV_MODE, m);
  } catch {
    // best-effort
  }
  return m;
}

// ── Persistencia de la biblioteca (snapshot) ─────────────────────────────────
const SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB por valor de KV (auto-impuesto)
const CHUNK_BYTES = 3_500_000; // ~3.5 MB de texto → ~4.7 MB cifrado
const chunkKey = (i: number) => `${KV_LIBRARY}:chunk:${i}`;

// Borra trozos contiguos desde `start` hasta el primer hueco.
async function deleteChunksFrom(env: any, start: number): Promise<void> {
  const kv = env?.VS_C3_KV;
  if (!kv || typeof kv.delete !== "function") return;
  for (let i = start; i < start + 100000; i++) {
    const v = await kv.get(chunkKey(i));
    if (v == null) break;
    await kv.delete(chunkKey(i));
  }
}

/**
 * Persiste la biblioteca en KV (`vs:library`) minificada y cifrada. A
 * diferencia de Sheer, REEMPLAZA el snapshot anterior (no es modo archivo): el
 * catálogo de Firestore ya es la fuente de verdad completa. Si el payload cifrado
 * supera 5 MB, lo reparte en trozos. Lanza si falta el secreto.
 */
export async function saveLibrary(library: VodsceneLibrary, env: any): Promise<VodsceneLibrary | null> {
  if (!env?.VS_C3_KV) return null;
  const secret = resolveSecret(env);
  if (!secret) {
    throw new Error("Falta la var/secret SHEER_KV_SECRET (o VODSCENE_KV_SECRET) para cifrar la biblioteca.");
  }

  const json = JSON.stringify(library); // minificado
  const payload = await encryptString(json, secret); // base64 ASCII → .length == bytes

  if (payload.length <= SIZE_LIMIT) {
    await env.VS_C3_KV.put(KV_LIBRARY, payload);
    await deleteChunksFrom(env, 0); // limpiar trozos de una versión troceada previa
    return library;
  }

  const bytes = new TextEncoder().encode(json);
  const chunks = Math.ceil(bytes.length / CHUNK_BYTES) || 1;
  for (let i = 0; i < chunks; i++) {
    const slice = bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    await env.VS_C3_KV.put(chunkKey(i), await encryptBytes(slice, secret));
  }
  await env.VS_C3_KV.put(KV_LIBRARY, JSON.stringify({ __chunked: true, chunks, bytes: bytes.length }));
  await deleteChunksFrom(env, chunks);
  return library;
}

/**
 * Lee y descifra la biblioteca de KV. Soporta valor único cifrado, manifiesto de
 * troceo y JSON plano legacy. Devuelve null si no existe o falta algún trozo.
 */
export async function loadLibrary(env: any): Promise<VodsceneLibrary | null> {
  try {
    const kv = env?.VS_C3_KV;
    const raw = await kv?.get(KV_LIBRARY);
    if (!raw) return null;
    const secret = resolveSecret(env);

    if (raw[0] === "{") {
      let manifest: any = null;
      try {
        manifest = JSON.parse(raw);
      } catch {
        manifest = null;
      }
      if (manifest && manifest.__chunked) {
        const parts: Uint8Array[] = [];
        let total = 0;
        for (let i = 0; i < manifest.chunks; i++) {
          const cp = await kv.get(chunkKey(i));
          if (cp == null) return null; // trozo faltante
          const bytes = await decryptBytes(cp, secret);
          parts.push(bytes);
          total += bytes.length;
        }
        const buf = new Uint8Array(total);
        let off = 0;
        for (const p of parts) {
          buf.set(p, off);
          off += p.length;
        }
        return JSON.parse(new TextDecoder().decode(buf));
      }
    }

    return await decryptJSON(raw, secret);
  } catch {
    return null;
  }
}

/** Resumen ligero de la biblioteca para el menú (sin exponer el catálogo). */
export async function libraryInfo(env: any): Promise<{
  hasLibrary: boolean;
  totalVideos: number;
  totalPlaylists: number;
  generatedAt: number | null;
}> {
  const lib = await loadLibrary(env);
  if (!lib) return { hasLibrary: false, totalVideos: 0, totalPlaylists: 0, generatedAt: null };
  return {
    hasLibrary: lib.totalVideos > 0,
    totalVideos: lib.totalVideos ?? 0,
    totalPlaylists: lib.totalPlaylists ?? 0,
    generatedAt: lib.generatedAt ?? null,
  };
}

/**
 * Construye un snapshot del catálogo llamando EN VIVO al endpoint de Firestore
 * (videos + playlists, con refresh). Pensado para ejecutarse en SSR desde la
 * página del scraper, que luego lo persiste con saveLibrary.
 */
export async function buildLibrary({
  origin,
  cookie = "",
}: {
  origin: string;
  cookie?: string;
}): Promise<VodsceneLibrary> {
  const res = await fetch(
    `${origin}/api/vodscene/firestore?collections=videos,playlists&refresh=true`,
    { headers: { cookie } },
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `El endpoint de Firestore respondió HTTP ${res.status}`);
  }
  const response = (await res.json()) as FirestoreResponse;
  const totalVideos = response.meta?.collections?.videos?.count ?? 0;
  const totalPlaylists = response.meta?.collections?.playlists?.count ?? 0;
  return { generatedAt: Date.now(), totalVideos, totalPlaylists, response };
}
