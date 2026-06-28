#!/usr/bin/env node
/**
 * download-video.mjs
 * Descarga un video de vodscene a MP4 dado su Firestore document ID.
 *
 * Uso:
 *   node scripts/download-video.mjs <videoId> [opciones]
 *
 * Opciones:
 *   --trailer            Forzar descarga del tráiler en lugar del video principal
 *   --output <dir>       Carpeta de destino (por defecto: ./downloads)
 *   --name <name>        Nombre base del archivo de salida (sin extensión)
 *   --wvd <path>         Archivo .wvd para descifrar DRM Widevine
 *   --key <kid:hexkey>   Clave de contenido directa (sin .wvd), ej: 51160ec1...:aabbcc... (puede repetirse para múltiples pistas)
 *   --quality <N>        Calidad de video: 1=240p 2=360p 3=480p 4=720p 5=1080p (default: 5)
 *
 * Ejemplos:
 *   node scripts/download-video.mjs ujCaNumx7ZAo239NBUzK
 *   node scripts/download-video.mjs ujCaNumx7ZAo239NBUzK --trailer
 *   node scripts/download-video.mjs ujCaNumx7ZAo239NBUzK --wvd ./device.wvd
 *   node scripts/download-video.mjs ujCaNumx7ZAo239NBUzK --key 51160ec1fb46...:aabbccddeeff...
 *   node scripts/download-video.mjs ujCaNumx7ZAo239NBUzK --output ~/Videos --name mi-video
 *
 * Requisitos:
 *   - Node.js 18+ (fetch nativo)
 *   - ffmpeg + mp4decrypt instalados en PATH
 *   - Para DRM: pywidevine (pip install pywidevine) + archivo .wvd ─ O bien la clave con --key
 */

import { spawnSync }                           from "node:child_process";
import { existsSync, mkdirSync, writeFileSync,
         unlinkSync, statSync }               from "node:fs";
import { resolve, join, dirname }             from "node:path";
import { fileURLToPath }                       from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Credenciales (extraídas de wrangler.toml) ─────────────────────────────────
const FIREBASE_API_KEY = "AIzaSyAUPv7dU2kEk1rdC__6z8aGlPYPfQh_ogA";
const FIREBASE_PROJECT = "payperview-7c21f";
const VODSCENE_EMAIL   = "m45942076@gmail.com";
const VODSCENE_PASSWORD = "minasricas00";

// ─── Colores ANSI ──────────────────────────────────────────────────────────────
const c = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  red:    "\x1b[31m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  blue:   "\x1b[34m",
  cyan:   "\x1b[36m",
  gray:   "\x1b[90m",
};
const log  = (msg)       => console.log(`${c.gray}▸${c.reset} ${msg}`);
const ok   = (msg)       => console.log(`${c.green}✔${c.reset} ${msg}`);
const warn = (msg)       => console.log(`${c.yellow}⚠${c.reset}  ${msg}`);
const err  = (msg, exit) => { console.error(`${c.red}✖${c.reset} ${msg}`); if (exit) process.exit(1); };
const info = (label, val)=> console.log(`  ${c.cyan}${label}${c.reset} ${c.dim}${val}${c.reset}`);

// ─── Parse args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(`
${c.bold}download-video.mjs${c.reset} — Descarga videos de vodscene a MP4

${c.yellow}Uso:${c.reset}
  node scripts/download-video.mjs <videoId> [--trailer] [--output <dir>] [--name <name>]
  node scripts/download-video.mjs <videoId> --wvd <device.wvd>      # descifrar DASH DRM
  node scripts/download-video.mjs <videoId> --key <kid:hexkey>      # clave directa
  node scripts/download-video.mjs --list [N]                        # listar últimos N videos

${c.yellow}Ejemplos:${c.reset}
  node scripts/download-video.mjs ujCaNumx7ZAo239NBUzK
  node scripts/download-video.mjs ujCaNumx7ZAo239NBUzK --wvd ./device.wvd
  node scripts/download-video.mjs ujCaNumx7ZAo239NBUzK --trailer
  node scripts/download-video.mjs ujCaNumx7ZAo239NBUzK --output ~/Videos
  node scripts/download-video.mjs --list
  node scripts/download-video.mjs --list 50
`);
  process.exit(0);
}

const listMode     = args[0] === "--list";
const listLimit    = listMode ? (parseInt(args[1], 10) || 20) : 0;
const videoId      = listMode ? null : args[0];
const forceTrailer = args.includes("--trailer");
const dumpDoc      = args.includes("--dump");
const outputDir   = (() => {
  const i = args.indexOf("--output");
  return i !== -1 && args[i + 1] ? resolve(args[i + 1]) : resolve("downloads");
})();
const customName  = (() => {
  const i = args.indexOf("--name");
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
})();
let wvdPath       = (() => {
  const i = args.indexOf("--wvd");
  return i !== -1 && args[i + 1] ? resolve(args[i + 1]) : null;
})();
const directKeys  = (() => {
  const keys = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--key" && args[i + 1]) keys.push(args[i + 1]);
  }
  return keys.length > 0 ? keys : null;
})();
const quality     = (() => {
  const i = args.indexOf("--quality");
  return i !== -1 && args[i + 1] ? parseInt(args[i + 1], 10) : 5;
})();

// ─── Verificar ffmpeg / mp4decrypt ────────────────────────────────────────────
function checkFfmpeg() {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "pipe" });
  if (result.error || result.status !== 0) {
    err("ffmpeg no encontrado. Instálalo con:", false);
    console.log("   macOS:  brew install ffmpeg");
    console.log("   Ubuntu: sudo apt install ffmpeg");
    process.exit(1);
  }
  const version = result.stdout?.toString().match(/ffmpeg version (\S+)/)?.[1] ?? "desconocida";
  ok(`ffmpeg detectado (versión ${version})`);
}

function checkMp4decrypt() {
  const result = spawnSync("mp4decrypt", ["--version"], { stdio: "pipe" });
  if (result.error) {
    err("mp4decrypt no encontrado. Instala Bento4:", false);
    console.log("   macOS:  brew install bento4");
    console.log("   Ubuntu: https://www.bento4.com/downloads/");
    process.exit(1);
  }
  ok("mp4decrypt detectado");
}

// ─── Firebase Auth ─────────────────────────────────────────────────────────────
async function getFirebaseToken() {
  log("Autenticando con Firebase...");
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Referer": "https://vodscene.com/",
        "Origin":  "https://vodscene.com",
      },
      body: JSON.stringify({ email: VODSCENE_EMAIL, password: VODSCENE_PASSWORD, returnSecureToken: true }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    err(`Fallo en autenticación Firebase (${res.status}): ${body}`, true);
  }
  const data = await res.json();
  ok("Token Firebase obtenido");
  return data.idToken;
}

// ─── Firestore: decodificar valores ───────────────────────────────────────────
function fsVal(v) {
  if (!v || typeof v !== "object") return v;
  if ("stringValue"    in v) return v.stringValue;
  if ("integerValue"   in v) return parseInt(v.integerValue, 10);
  if ("doubleValue"    in v) return v.doubleValue;
  if ("booleanValue"   in v) return v.booleanValue;
  if ("nullValue"      in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue"       in v) return fsFields(v.mapValue?.fields ?? {});
  if ("arrayValue"     in v) return (v.arrayValue?.values ?? []).map(fsVal);
  return v;
}
function fsFields(fields) {
  const obj = {};
  for (const [k, val] of Object.entries(fields)) obj[k] = fsVal(val);
  return obj;
}

// ─── Firestore: obtener documento ─────────────────────────────────────────────
async function getVideoDoc(token, docId) {
  log(`Buscando video ${c.bold}${docId}${c.reset}${c.gray} en Firestore...${c.reset}`);
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/videos/${docId}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) err(`Video "${docId}" no encontrado en Firestore.`, true);
  if (!res.ok) err(`Error Firestore (${res.status}): ${await res.text()}`, true);

  const doc = await res.json();
  if (!doc.fields) err("Documento sin campos.", true);
  return { id: docId, ...fsFields(doc.fields) };
}

// ─── Determinar modo de reproducción (igual que el frontend) ──────────────────
function getPlayMode(v) {
  if (v.processingStatus !== "ready") return "unavailable";
  if (v.permitirPlaySinDRM || v.hasNoDRMVersion)       return "nodrm";
  if (v.drm?.enabled && v.publicUrls?.dashManifest)    return "widevine";
  if (v.publicUrls?.trailerManifest)                   return "trailer";
  return "unavailable";
}

// ─── Sanitizar nombre de archivo ───────────────────────────────────────────────
function sanitize(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_{2,}/g, "_")
    .substring(0, 120)
    .trim();
}

// ─── Descarga con ffmpeg ────────────────────────────────────────────────────────
function downloadWithFfmpeg(manifestUrl, outputPath, title) {
  console.log();
  console.log(`${c.bold}Iniciando descarga...${c.reset}`);
  info("Fuente :", manifestUrl);
  info("Destino:", outputPath);
  console.log();

  const ffmpegArgs = [
    "-y",                        // sobrescribir si existe
    "-loglevel", "warning",      // solo warnings/errores en consola
    "-stats",                    // mostrar progreso
    "-i", manifestUrl,           // input
    "-c", "copy",                // copiar streams sin recodificar (más rápido)
    "-movflags", "+faststart",   // mover moov atom al inicio (streaming friendly)
    outputPath,
  ];

  const result = spawnSync("ffmpeg", ffmpegArgs, {
    stdio: "inherit",
    maxBuffer: 100 * 1024 * 1024,
  });

  if (result.error) err(`Error al ejecutar ffmpeg: ${result.error.message}`, true);
  if (result.status !== 0) err(`ffmpeg terminó con código ${result.status}`, true);
}

// ─── Parsear MPD y extraer info ────────────────────────────────────────────────
function parseMpd(mpdXml, mpdBaseUrl) {
  // Extraer PSSH Widevine (urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed)
  const psshMatch = mpdXml.match(/<cenc:pssh>([^<]+)<\/cenc:pssh>/);
  const pssh = psshMatch ? psshMatch[1].trim() : null;

  // Base URL del directorio del MPD
  const base = mpdBaseUrl.replace(/\/[^/]+$/, "/");

  // Extraer representaciones de video (AdaptationSet mimeType=video)
  const videoReps = [];
  const videoSection = mpdXml.match(/<AdaptationSet[^>]*mimeType="video\/mp4"[\s\S]*?<\/AdaptationSet>/);
  if (videoSection) {
    const repRegex = /<Representation([^>]+)>\s*<BaseURL>([^<]+)<\/BaseURL>/g;
    let m;
    while ((m = repRegex.exec(videoSection[0])) !== null) {
      const attrs      = m[1];
      const file       = m[2];
      const bandwidth  = parseInt(attrs.match(/bandwidth="(\d+)"/)?.[1] ?? "0", 10);
      const height     = parseInt(attrs.match(/height="(\d+)"/)?.[1] ?? "0", 10);
      videoReps.push({ bandwidth, height, file, url: base + file });
    }
  }
  // Ordenar por calidad descendente
  videoReps.sort((a, b) => b.bandwidth - a.bandwidth);

  // Extraer primera representación de audio
  const audioMatch = mpdXml.match(/<AdaptationSet[^>]*mimeType="audio\/mp4"[\s\S]*?<BaseURL>([^<]+)<\/BaseURL>/);
  const audioFile  = audioMatch ? audioMatch[1] : null;
  const audioUrl   = audioFile ? base + audioFile : null;

  return { pssh, videoReps, audioUrl, audioFile, base };
}

// ─── Descargar archivo grande con progreso ─────────────────────────────────────
async function downloadFile(url, destPath, label) {
  log(`Descargando ${label}...`);
  const res = await fetch(url);
  if (!res.ok) err(`Error al descargar ${label} (${res.status})`, true);
  const total = parseInt(res.headers.get("content-length") ?? "0", 10);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) {
      const pct = Math.round(received / total * 100);
      process.stdout.write(`\r  ${c.dim}${label}: ${pct}% (${(received/1024/1024).toFixed(1)} MB)${c.reset}   `);
    }
  }
  process.stdout.write("\r" + " ".repeat(60) + "\r");
  const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
  writeFileSync(destPath, buf);
  const mb = (buf.length / 1024 / 1024).toFixed(1);
  ok(`${label} descargado (${mb} MB) → ${destPath}`);
}

// ─── Extraer claves ClearKey almacenadas en Firestore ─────────────────────────
function extractFsKeys(video) {
  const keys = {};  // { kid: keyHex }
  const drm = video.drm ?? {};
  const fp  = video.fairplay ?? {};

  // 1. drm.keyId + drm.keyHex  (esquema principal)
  if (drm.keyId && drm.keyHex) {
    keys[drm.keyId.replace(/-/g, "")] = drm.keyHex;
  }
  // 2. drm.encryptionKey  "kid:key"
  if (drm.encryptionKey && drm.encryptionKey.includes(":")) {
    const [kid, key] = drm.encryptionKey.split(":");
    if (kid && key) keys[kid.replace(/-/g, "")] = key;
  }
  // 3. Array raíz "keys": [{ keyId, key }, ...]
  if (Array.isArray(video.keys)) {
    for (const k of video.keys) {
      if (k.keyId && k.key) {
        keys[k.keyId.replace(/-/g, "")] = k.key;
      }
    }
  }
  return Object.keys(keys).length > 0
    ? Object.entries(keys).map(([kid, key]) => ({ kid, key }))
    : null;
}

// ─── Obtener claves Widevine ───────────────────────────────────────────────────
async function getWidevineKeys(pssh, licenseUrl, token, video) {
  // Opción 1: clave(s) directa(s) provistas con --key kid:hex (puede haber varias)
  if (directKeys) {
    const parsed = directKeys.map(dk => {
      const parts = dk.split(":");
      if (parts.length !== 2) err(`Formato --key inválido: "${dk}". Usa: kid_hex:key_hex`, true);
      return { kid: parts[0], key: parts[1] };
    });
    ok(`${parsed.length} clave(s) directa(s) (--key):`);
    for (const k of parsed) info("  Clave:", `${k.kid}:${k.key}`);
    return parsed;
  }

  // Opción 2: claves ClearKey en Firestore (drm.keyHex / fairplay.keyHex / keys[])
  if (video) {
    const fsKeys = extractFsKeys(video);
    if (fsKeys) {
      ok(`${fsKeys.length} clave(s) ClearKey obtenida(s) de Firestore`);
      for (const k of fsKeys) info("  Clave FS:", `${k.kid}:${k.key}`);
      return fsKeys;
    }
  }

  // Opción 3: via pywidevine + .wvd
  const wvd = wvdPath ?? (() => {
    const candidates = [
      join(__dirname, "device.wvd"),
      join(__dirname, "..", "device.wvd"),
    ];
    return candidates.find(existsSync) ?? null;
  })();

  if (!wvd) {
    err("No se puede descifrar DRM: no hay claves en Firestore, y falta --key o --wvd", false);
    err("Opciones:", false);
    console.log(`     ${c.dim}a) --wvd device.wvd   (Widevine CDM device + pywidevine)${c.reset}`);
    console.log(`     ${c.dim}b) --key <kid:hexkey>  (clave obtenida previamente)${c.reset}`);
    process.exit(1);
  }

  log(`Obteniendo claves Widevine via pywidevine (device: ${wvd})...`);
  const pyScript = join(__dirname, "get-widevine-keys.py");
  const result = spawnSync("python3", [
    pyScript,
    "--pssh",        pssh,
    "--license-url", licenseUrl,
    "--token",       token,
    "--wvd",         wvd,
  ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });

  if (result.error) err(`Error al ejecutar get-widevine-keys.py: ${result.error.message}`, true);

  let parsed;
  try { parsed = JSON.parse(result.stdout.trim()); } catch {
    err(`Respuesta inesperada de get-widevine-keys.py:\n${result.stdout}\n${result.stderr}`, true);
  }
  if (parsed.error) err(`Error al obtener claves: ${parsed.error}`, true);
  ok(`${parsed.keys.length} clave(s) obtenida(s) del servidor de licencias`);
  return parsed.keys;
}

// ─── Descifrar con mp4decrypt ──────────────────────────────────────────────────
function decryptMp4(inputPath, outputPath, keys) {
  const keyArgs = keys.flatMap(k => ["--key", `${k.kid}:${k.key}`]);
  log(`Descifrando ${inputPath}...`);
  const result = spawnSync("mp4decrypt", [...keyArgs, inputPath, outputPath], {
    stdio: "inherit",
  });
  if (result.error) err(`Error al ejecutar mp4decrypt: ${result.error.message}`, true);
  if (result.status !== 0) err(`mp4decrypt terminó con código ${result.status}`, true);
  ok(`Descifrado OK → ${outputPath}`);
}

// ─── Muxear video + audio con ffmpeg ──────────────────────────────────────────
function muxWithFfmpeg(videoPath, audioPath, outputPath) {
  console.log();
  console.log(`${c.bold}Muxeando video + audio...${c.reset}`);
  info("Video :", videoPath);
  info("Audio :", audioPath);
  info("Salida:", outputPath);
  console.log();
  const result = spawnSync("ffmpeg", [
    "-y",
    "-nostdin",
    "-loglevel", "warning",
    "-fflags", "+genpts",
    "-i", videoPath,
    "-fflags", "+genpts",
    "-i", audioPath,
    "-c:v", "copy",
    "-c:a", "copy",
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+faststart",
    outputPath,
  ], { stdio: "inherit" });
  if (result.error) err(`Error al ejecutar ffmpeg: ${result.error.message}`, true);
  if (result.status !== 0) err(`ffmpeg terminó con código ${result.status}`, true);
}

// ─── Flujo completo: descarga + descifrado + muxeo DASH DRM ───────────────────
async function downloadAndDecryptDash(video, token, outputPath) {
  const mpdUrl = video.publicUrls?.dashManifest;
  if (!mpdUrl) err("No hay dashManifest en publicUrls.", true);

  console.log();
  console.log(`${c.bold}Descarga DASH + descifrado Widevine${c.reset}`);
  console.log(`${c.dim}${"-".repeat(50)}${c.reset}`);

  // 1. Descargar MPD
  log("Descargando MPD...");
  const mpdRes = await fetch(mpdUrl);
  if (!mpdRes.ok) err(`Error al descargar MPD (${mpdRes.status})`, true);
  const mpdXml = await mpdRes.text();

  // 2. Parsear MPD
  const { pssh, videoReps, audioUrl, audioFile, base } = parseMpd(mpdXml, mpdUrl);
  if (!pssh) err("No se encontró PSSH Widevine en el MPD.", true);
  if (!videoReps.length) err("No se encontraron representaciones de video en el MPD.", true);
  if (!audioUrl) err("No se encontró pista de audio en el MPD.", true);

  // Seleccionar calidad
  const qualityIdx = Math.max(0, Math.min(videoReps.length - 1, videoReps.length - quality));
  const videoRep   = videoReps[qualityIdx];
  info("PSSH        :", pssh);
  info("Video selec.:", `${videoRep.height}p (${(videoRep.bandwidth/1000).toFixed(0)} kbps) → ${videoRep.file}`);
  info("Audio       :", audioFile);
  info("License URL :", video.drm?.widevine?.licenseUrl);
  console.log();

  // 3. Obtener claves (primero busca en Firestore, luego WVD)
  let licenseUrl = video.drm?.widevine?.licenseUrl ?? null;
  // Añadir CustomData para EZDRM (igual que el web player)
  if (licenseUrl && licenseUrl.includes("ezdrm.com")) {
    const customData = encodeURIComponent(JSON.stringify({
      userId:  video.uploadedBy ?? video.uploaderId ?? "",
      videoId: video.id,
    }));
    licenseUrl += (licenseUrl.includes("?") ? "&" : "?") + "CustomData=" + customData;
    log(`CustomData añadido a URL de licencia EZDRM`);
  }
  if (!licenseUrl && !directKeys && !extractFsKeys(video)) err("No hay licenseUrl de Widevine ni claves en Firestore.", true);
  const keys = await getWidevineKeys(pssh, licenseUrl, token, video);
  console.log();
  for (const k of keys) info("  Clave:", `${k.kid}:${k.key}`);
  console.log();

  // 4. Descargar archivos cifrados a directorio temporal
  const tmpDir = join(outputDir, ".tmp_" + video.id);
  mkdirSync(tmpDir, { recursive: true });
  const encVideoPath = join(tmpDir, videoRep.file);
  const encAudioPath = join(tmpDir, audioFile);
  const decVideoPath = join(tmpDir, `dec_${videoRep.file}`);
  const decAudioPath = join(tmpDir, `dec_${audioFile}`);

  await downloadFile(videoRep.url, encVideoPath, `video ${videoRep.height}p`);
  await downloadFile(audioUrl,     encAudioPath, "audio");

  // 5. Descifrar
  console.log();
  decryptMp4(encVideoPath, decVideoPath, keys);
  decryptMp4(encAudioPath, decAudioPath, keys);

  // 6. Muxear
  muxWithFfmpeg(decVideoPath, decAudioPath, outputPath);

  // 7. Limpiar temporales
  try {
    [encVideoPath, encAudioPath, decVideoPath, decAudioPath].forEach(f => { try { unlinkSync(f); } catch {} });
    try { mkdirSync(tmpDir); } catch {} // Ignora si no está vacío
  } catch {}

  const mb = (statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log();
  ok(`${c.bold}Descarga y descifrado completados${c.reset}`);
  info("Archivo:", outputPath);
  info("Tamaño :", `${mb} MB`);
}

// ─── Listar videos ────────────────────────────────────────────────────────────
async function listVideos(token, limit = 20) {
  log(`Listando últimos ${limit} videos en Firestore...`);
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/videos?pageSize=${limit}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) err(`Error Firestore (${res.status}): ${await res.text()}`, true);
  const data = await res.json();
  const docs = data.documents ?? [];
  console.log();
  console.log(`  ${c.bold}${c.cyan}Videos en Firestore (${docs.length} de ${limit} pedidos)${c.reset}`);
  console.log(`  ${c.dim}${"─".repeat(72)}${c.reset}`);
  const modeColor = { nodrm: c.green, widevine: c.yellow, trailer: c.cyan, unavailable: c.red };
  for (const doc of docs) {
    if (!doc.fields) continue;
    const v    = { id: doc.name.split("/").pop(), ...fsFields(doc.fields) };
    const mode = getPlayMode(v);
    const mc   = modeColor[mode] ?? c.dim;
    const fvJob    = v.coconutJobStatus?.fullVideo;
    const fvStatus = fvJob?.status ?? "—";
    const fvColor  = fvStatus === "completed" ? c.green
                   : fvStatus === "processing" ? c.yellow
                   : fvStatus === "queued"     ? c.dim
                   : c.dim;
    const fvInfo = fvJob?.jobId ? `fullVideo:${fvColor}${fvStatus}${c.reset}` : `fullVideo:${c.dim}${fvStatus}${c.reset}`;
    const titleStr = (v.title ?? "—").substring(0, 40);
    console.log(
      `  ${c.bold}${v.id}${c.reset}  ` +
      `${mc}${mode.padEnd(12)}${c.reset}  ` +
      `${fvInfo.padEnd(30)}  ` +
      `${c.dim}${titleStr}${c.reset}`
    );
  }
  console.log();
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log();
  console.log(`${c.bold}${c.cyan}vodscene downloader${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}`);
  console.log();

  // ─ Modo listado ─
  if (listMode) {
    const token = await getFirebaseToken();
    await listVideos(token, listLimit);
    return;
  }

  if (!videoId) err("Debes indicar un <videoId> o usar --list.", true);

  checkFfmpeg();
  checkMp4decrypt();
  console.log();

  const token = await getFirebaseToken();
  const video = await getVideoDoc(token, videoId);
  console.log();

  // ─ Dump completo si se pide ─
  if (dumpDoc) {
    console.log(`${c.bold}${c.cyan}── Documento Firestore (raw) ──${c.reset}`);
    console.log(JSON.stringify(video, null, 2));
    console.log();
  }

  // Mostrar info básica
  const title  = video.title ?? video.id;
  const mode   = getPlayMode(video);
  const slug   = video.slug ?? "—";
  const wantDrmdecrypt = !!(wvdPath || directKeys);

  // En modo widevine: verificar si hay claves en Firestore antes de pedir WVD
  // Auto-detectar .wvd si no se pasó --key ni --wvd
  const autoWvd = (() => {
    if (wantDrmdecrypt) return null; // ya hay --key o --wvd
    const candidates = [
      join(__dirname, "device.wvd"),
      join(__dirname, "..", "device.wvd"),
    ];
    return candidates.find(existsSync) ?? null;
  })();
  if (autoWvd && !wvdPath) {
    wvdPath = autoWvd;
    ok(`Auto-detected WVD: ${autoWvd}`);
  }
  const canDecrypt = !!(wvdPath || directKeys);

  if (mode === "widevine" && !canDecrypt) {
    const fsKeys = extractFsKeys(video);
    if (fsKeys) {
      // Hay claves ClearKey en Firestore → proceder directamente
      ok(`Claves ClearKey encontradas en Firestore (${fsKeys.length})`);
      for (const k of fsKeys) info("  Clave:", `${k.kid}:${k.key}`);
      // Continúa al flujo de descarga DRM más abajo
    } else {
      warn("Este video está protegido con Widevine DRM.");
      warn(`No hay claves ClearKey en Firestore para este video (usa EZDRM pX=${video.drm?.widevine?.licenseUrl?.match(/pX=([\w]+)/)?.[1] ?? '?'}).`);
      // Mostrar el contenido RAW de drm y fairplay para diagnóstico
      console.log();
      console.log(`  ${c.bold}${c.cyan}── Respuesta Firestore (drm + fairplay) ──${c.reset}`);
      console.log(JSON.stringify({ drm: video.drm ?? null, fairplay: video.fairplay ?? null }, null, 2).split("\n").map(l => "  " + l).join("\n"));
      console.log();
      warn("Para descargar el video completo necesitas:");
      console.log(`     ${c.dim}a) --wvd device.wvd   (Widevine CDM device + pywidevine)${c.reset}`);
      console.log(`     ${c.dim}b) --key <kid:hexkey>  (clave obtenida previamente)${c.reset}`);
      const kid = video.drm?.keyId ?? '';
      if (kid) console.log(`     ${c.dim}KID conocido: ${kid}${c.reset}`);
      // Mostrar estado del job fullVideo de Coconut
      const fvJob = video.coconutJobStatus?.fullVideo;
      if (fvJob) {
        if (fvJob.status === "queued" && !fvJob.jobId) {
          warn(`Job 'fullVideo' en cola sin iniciar — cuando se procese habrá versión sin DRM.`);
        } else if (fvJob.status === "queued") {
          warn(`Job 'fullVideo' en cola (jobId: ${fvJob.jobId}) — aún no completado.`);
        } else if (fvJob.status === "processing") {
          warn(`Job 'fullVideo' procesando... ${fvJob.progress ?? 0}% — usa --list para monitorear.`);
        } else if (fvJob.status === "completed") {
          ok("Job 'fullVideo' completado — puede que publicUrls no esté actualizado aún.");
        }
      }
      err("No se puede descargar el video completo sin clave de descifrado. Usa --trailer para el tráiler.", true);
    }
  }
  info("Título:", title);
  info("Slug  :", slug);
  info("Estado:", `processingStatus=${video.processingStatus} | isActive=${video.isActive}`);
  info("Modo  :", mode);

  // ─ Mostrar siempre las claves DRM disponibles ─
  const keyId     = video.drm?.keyId;
  const wvUrl     = video.drm?.widevine?.licenseUrl;
  const prUrl     = video.drm?.playready?.laUrl ?? video.drm?.playready?.licenseUrl;
  const fpIv      = video.fairplay?.ivHex;
  const fpLicUrl  = video.fairplay?.licenseUrl;
  const fpKid     = video.fairplay?.kid;
  const drmPssh   = video.drm?.widevine?.pssh;
  const hasDRM    = keyId || wvUrl || fpIv || fpKid || drmPssh;
  if (hasDRM) {
    console.log();
    console.log(`  ${c.bold}🔒 DRM info${c.reset}`);
    if (keyId)    info("  Key ID (Common)   :", keyId);
    if (drmPssh)  info("  PSSH (Widevine)   :", drmPssh);
    if (wvUrl)    info("  Widevine URL      :", wvUrl);
    if (prUrl)    info("  PlayReady URL     :", prUrl);
    if (fpIv)     info("  FairPlay IV       :", fpIv);
    if (fpKid)    info("  FairPlay KID      :", fpKid);
    if (fpLicUrl) info("  FairPlay Lic URL  :", fpLicUrl);
  }

  // ─ Mostrar URLs de manifiestos disponibles ─
  console.log();
  console.log(`  ${c.bold}📦 Manifiestos${c.reset}`);
  const pu = video.publicUrls ?? {};
  for (const [k, v] of Object.entries(pu)) {
    if (typeof v === "string" && (v.endsWith(".m3u8") || v.endsWith(".mpd") || v.includes("manifest"))) {
      info(`  ${k.padEnd(26)}:`, v);
    }
  }
  console.log();

  // ─ Decidir manifest URL ─
  let manifestUrl = null;
  let downloadType = "";

  if (forceTrailer) {
    manifestUrl = video.publicUrls?.trailerManifest ?? null;
    downloadType = "tráiler (HLS)";
    if (!manifestUrl) err("No hay tráiler disponible para este video.", true);
  } else if (mode === "nodrm") {
    manifestUrl = video.publicUrls?.dashManifestNoDRM ?? video.publicUrls?.dashManifest ?? null;
    downloadType = "video completo sin DRM (DASH)";
  } else if (mode === "widevine") {
    // Las claves vienen de Firestore (ClearKey), o de --key/--wvd
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
      ok(`Carpeta creada: ${outputDir}`);
    }
    const baseName   = customName ?? sanitize(title !== video.id ? title : video.slug ?? video.id);
    const outputPath = join(outputDir, `${baseName}.mp4`);
    await downloadAndDecryptDash(video, token, outputPath);
    console.log();
    return;
  } else if (mode === "trailer") {
    manifestUrl = video.publicUrls?.trailerManifest ?? null;
    downloadType = "tráiler (HLS)";
    if (!manifestUrl) err("No hay tráiler disponible.", true);
  } else {
    // unavailable
    err(`Video no disponible para descarga (processingStatus="${video.processingStatus}", isActive=${video.isActive})`, true);
  }

  info("Fuente:", downloadType);
  console.log();

  // ─ Preparar ruta de salida ─
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
    ok(`Carpeta creada: ${outputDir}`);
  }

  const baseName   = customName ?? sanitize(title !== video.id ? title : video.slug ?? video.id);
  const suffix     = forceTrailer || downloadType.includes("tráiler") ? "_trailer" : "";
  const outputPath = join(outputDir, `${baseName}${suffix}.mp4`);

  // ─ Descargar ─
  downloadWithFfmpeg(manifestUrl, outputPath, title);
  console.log();
  ok(`${c.bold}Descarga completada${c.reset}`);
  info("Archivo:", outputPath);

  // ─ Mostrar tamaño ─
  try {
    const bytes = statSync(outputPath).size;
    const mb = (bytes / 1024 / 1024).toFixed(1);
    info("Tamaño :", `${mb} MB`);
  } catch { /* no crítico */ }

  console.log();
}

main().catch((e) => {
  err(e?.message ?? String(e), false);
  process.exit(1);
});
