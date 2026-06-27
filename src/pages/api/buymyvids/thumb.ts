import type { APIRoute } from "astro";

export const prerender = false;

// ─── Generador de miniaturas vía "faststart" sobre la marcha ────────────────────
// Los videos del CDN no son "faststart": el átomo `moov` (índice de muestras) está
// al FINAL del archivo y `mdat` (datos) al inicio. Por eso el navegador necesitaría
// descargar casi todo el archivo (cientos de MB) sólo para decodificar un fotograma,
// y además el CDN no envía cabeceras CORS.
//
// Este endpoint resuelve ambos problemas server-side:
//   1. Lee la cabecera (ftyp + cabecera de mdat + primeros frames).
//   2. Lee el `moov` desde el final.
//   3. Reensambla un mp4 pequeño y válido con layout faststart:
//        [ftyp...] [moov (offsets corregidos)] [mdat truncado]
//      desplazando los chunk offsets (stco/co64) en `moovSize` bytes.
//   4. Lo devuelve same-origin → el navegador decodifica el primer frame con ~2 MB
//      y el canvas no queda "tainted".

const ALLOWED_HOST = "1582319782.rsc.cdn77.org";
const HEAD_BYTES = 1_500_000;   // trozo inicial de mdat (contiene los primeros frames)
const MOOV_MAX   = 8_000_000;   // tope de seguridad para el moov

const CONTAINERS = new Set([
  "moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta", "mvex", "gmhd",
]);

function typeAt(b: Uint8Array, pos: number): string {
  return String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3]);
}

// Recorre las cajas y suma `delta` a los offsets de stco/co64 (in-place).
function patchChunkOffsets(buf: Uint8Array, start: number, end: number, delta: number) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = start;
  while (pos + 8 <= end) {
    let size = dv.getUint32(pos);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(pos + 8)); hdr = 16; }
    else if (size === 0) { size = end - pos; }
    if (size < 8 || pos + size > end) break;
    const type = typeAt(buf, pos + 4);
    if (type === "stco") {
      const count = dv.getUint32(pos + hdr + 4);
      let p = pos + hdr + 8;
      for (let i = 0; i < count && p + 4 <= end; i++, p += 4) {
        dv.setUint32(p, (dv.getUint32(p) + delta) >>> 0);
      }
    } else if (type === "co64") {
      const count = dv.getUint32(pos + hdr + 4);
      let p = pos + hdr + 8;
      const d = BigInt(delta);
      for (let i = 0; i < count && p + 8 <= end; i++, p += 8) {
        dv.setBigUint64(p, dv.getBigUint64(p) + d);
      }
    } else if (CONTAINERS.has(type)) {
      patchChunkOffsets(buf, pos + hdr, pos + size, delta);
    }
    pos += size;
  }
}

async function rangeFetch(url: string, range: string): Promise<Uint8Array | null> {
  try {
    const r = await fetch(url, { headers: { Range: range } });
    if (!r.ok && r.status !== 206) return null;
    return new Uint8Array(await r.arrayBuffer());
  } catch {
    return null;
  }
}

export const GET: APIRoute = async ({ request }) => {
  const target = new URL(request.url).searchParams.get("url");
  if (!target) return new Response("Missing url", { status: 400 });

  let parsed: URL;
  try { parsed = new URL(target); } catch { return new Response("Bad url", { status: 400 }); }
  if (parsed.protocol !== "https:" || parsed.hostname !== ALLOWED_HOST) {
    return new Response("Forbidden host", { status: 403 });
  }
  const url = parsed.toString();

  const head = await rangeFetch(url, `bytes=0-${HEAD_BYTES}`);
  if (!head || head.length < 16) return new Response("No head", { status: 502 });
  const headDv = new DataView(head.buffer, head.byteOffset, head.byteLength);

  // Recorre los átomos de nivel superior hasta encontrar `mdat` (o `moov` si ya es faststart).
  let pos = 0;
  let mdatHeaderStart = -1, mdatHeaderLen = 0, mdatTotalSize = 0;
  let alreadyFaststart = false;
  while (pos + 8 <= head.length) {
    let size = headDv.getUint32(pos);
    let hdr = 8;
    if (size === 1) { size = Number(headDv.getBigUint64(pos + 8)); hdr = 16; }
    const type = typeAt(head, pos + 4);
    if (type === "moov") { alreadyFaststart = true; break; }
    if (type === "moof") return new Response("Fragmented mp4 unsupported", { status: 422 });
    if (type === "mdat") {
      mdatHeaderStart = pos;
      mdatHeaderLen = hdr;
      mdatTotalSize = size;
      break;
    }
    if (size < 8) break;
    pos += size;
  }

  // Cabeceras de respuesta comunes.
  const respHeaders = (ct: string) => new Headers({
    "content-type": ct || "video/mp4",
    "cache-control": "public, max-age=86400",
    "access-control-allow-origin": "*",
  });

  // Ya es faststart (moov al inicio): el head truncado ya es decodificable.
  if (alreadyFaststart) {
    return new Response(head, { status: 200, headers: respHeaders("video/mp4") });
  }
  if (mdatHeaderStart < 0) return new Response("No mdat found", { status: 422 });

  // El moov empieza justo después del mdat completo, al final del archivo.
  const moovStart = mdatHeaderStart + mdatTotalSize;
  const moovRegion = await rangeFetch(url, `bytes=${moovStart}-${moovStart + MOOV_MAX}`);
  if (!moovRegion || moovRegion.length < 8) return new Response("No moov", { status: 502 });

  const moovDv = new DataView(moovRegion.buffer, moovRegion.byteOffset, moovRegion.byteLength);
  let moovSize = moovDv.getUint32(0);
  let moovHdr = 8;
  if (moovSize === 1) { moovSize = Number(moovDv.getBigUint64(8)); moovHdr = 16; }
  if (typeAt(moovRegion, 4) !== "moov" || moovSize < moovHdr) {
    return new Response("Bad moov", { status: 422 });
  }
  if (moovSize > moovRegion.length) return new Response("moov truncated", { status: 502 });
  const moov = moovRegion.slice(0, moovSize);

  // Insertamos moov antes de mdat (manteniendo la cabecera de mdat) → los offsets
  // del payload se desplazan exactamente `moovSize` bytes.
  patchChunkOffsets(moov, 0, moov.length, moovSize);

  // Trozo de payload de mdat que conservamos (los primeros frames).
  const payloadStart = mdatHeaderStart + mdatHeaderLen;
  const keptPayload = head.subarray(payloadStart);
  const newMdatTotal = mdatHeaderLen + keptPayload.length;

  // Reescribe la cabecera de mdat con el nuevo tamaño (mismo largo de cabecera).
  const newMdatHeader = new Uint8Array(mdatHeaderLen);
  const nh = new DataView(newMdatHeader.buffer);
  if (mdatHeaderLen === 16) {
    nh.setUint32(0, 1);
    newMdatHeader.set([0x6d, 0x64, 0x61, 0x74], 4); // 'mdat'
    nh.setBigUint64(8, BigInt(newMdatTotal));
  } else {
    nh.setUint32(0, newMdatTotal);
    newMdatHeader.set([0x6d, 0x64, 0x61, 0x74], 4);
  }

  const prefix = head.subarray(0, mdatHeaderStart); // ftyp (+ otros átomos previos)
  const out = new Uint8Array(prefix.length + moov.length + newMdatHeader.length + keptPayload.length);
  let o = 0;
  out.set(prefix, o); o += prefix.length;
  out.set(moov, o); o += moov.length;
  out.set(newMdatHeader, o); o += newMdatHeader.length;
  out.set(keptPayload, o);

  return new Response(out, { status: 200, headers: respHeaders("video/mp4") });
};
