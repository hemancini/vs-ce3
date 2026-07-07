// Interactividad de PostCard.astro mediante delegación de eventos a nivel
// documento. Funciona también para cards inyectadas dinámicamente (scroll
// infinito) porque los listeners viven en `document`, no en cada card.

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function isMp4Src(src: string, mime: string) {
  return mime === "video/mp4" || src.includes("transcode=mp4");
}
function isHlsSrc(src: string, mime: string) {
  return !isMp4Src(src, mime) && (mime === "application/x-mpegURL" || src.includes(".m3u8"));
}

// hls.js se carga por CDN en la página. Guardamos la instancia por <video> para
// poder destruirla (cambio HLS <-> MP4 en la página de detalle).
const hlsByVideo = new WeakMap<HTMLVideoElement, any>();

function setupVideo(video: HTMLVideoElement, src: string, mime: string, autoplay: boolean) {
  const Hls = (window as any).Hls;
  const existing = hlsByVideo.get(video);
  if (existing) {
    existing.destroy();
    hlsByVideo.delete(video);
  }
  video.removeAttribute("src");

  if (isHlsSrc(src, mime) && Hls && Hls.isSupported()) {
    const hls = new Hls({
      xhrSetup: (xhr: XMLHttpRequest) => {
        xhr.withCredentials = true;
      },
    });
    hls.loadSource(src);
    hls.attachMedia(video);
    hlsByVideo.set(video, hls);
    if (autoplay) {
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    }
  } else {
    // MP4 nativo o Safari con soporte HLS nativo.
    video.src = src;
    video.load();
    if (autoplay) video.play().catch(() => {});
  }
}

// Reemplaza el poster del feed por un <video> que reproduce de inmediato.
function playFeedVideo(poster: HTMLElement) {
  const src = poster.dataset.videoSrc;
  if (!src) return;
  const mime = poster.dataset.videoMime || "";

  const wrapper = document.createElement("div");
  wrapper.className =
    "video-player-container video-wrapper aspect-square bg-black relative overflow-hidden";
  const video = document.createElement("video");
  video.className = "w-full h-full object-contain";
  video.controls = true;
  video.playsInline = true;
  if (poster.dataset.thumbnail) video.poster = poster.dataset.thumbnail;
  wrapper.appendChild(video);
  poster.replaceWith(wrapper);

  setupVideo(video, src, mime, true);
}

// Carga SOLO el manifest (master + variante) para obtener la duración en hover,
// sin descargar segmentos .ts.
const durationLoaded = new WeakSet<HTMLElement>();
function loadDuration(poster: HTMLElement) {
  if (durationLoaded.has(poster)) return;
  const src = poster.dataset.videoSrc;
  if (!src) return;
  durationLoaded.add(poster);
  const mime = poster.dataset.videoMime || "";
  const badge = poster.querySelector<HTMLElement>(".video-duration");
  const setBadge = (d: number) => {
    if (badge && isFinite(d) && d > 0) badge.textContent = formatDuration(d);
  };

  const Hls = (window as any).Hls;
  if (isHlsSrc(src, mime) && Hls && Hls.isSupported()) {
    const hls = new Hls({
      xhrSetup: (xhr: XMLHttpRequest) => {
        xhr.withCredentials = true;
      },
      autoStartLoad: false,
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => hls.startLoad());
    hls.on(Hls.Events.LEVEL_LOADED, (_e: any, data: any) => {
      const d = data?.details?.totalduration;
      if (d) setBadge(d);
      hls.destroy();
    });
    hls.on(Hls.Events.ERROR, (_e: any, data: any) => {
      if (data?.fatal) {
        hls.destroy();
        durationLoaded.delete(poster);
      }
    });
    hls.loadSource(src);
    return;
  }

  // MP4 / nativo: metadata con un <video> oculto.
  const v = document.createElement("video");
  v.preload = "metadata";
  v.onloadedmetadata = () => {
    setBadge(v.duration);
    v.removeAttribute("src");
    v.load();
  };
  v.onerror = () => durationLoaded.delete(poster);
  v.src = src;
}

// --- Audio player ---
// Tiempo en formato m:ss (los audios de Arsmate son notas de voz cortas).
function formatAudioTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Los eventos de media (loadedmetadata/timeupdate) NO burbujean, así que no se
// pueden delegar: enganchamos los listeners en el <audio> la primera vez que se
// interactúa con su card. Idempotente vía WeakSet.
const audioWired = new WeakSet<HTMLAudioElement>();
// Mantiene vivas las sondas de duración hasta que resuelven (evita GC).
const durationProbes = new Set<HTMLAudioElement>();
// Duración real conocida por <audio> (las notas de voz webm de MediaRecorder
// vienen con duration=Infinity, así que la resolvemos aparte).
const knownDurations = new WeakMap<HTMLAudioElement, number>();

// Los webm grabados con MediaRecorder no traen duración en la cabecera:
// audio.duration sale Infinity. El truco estándar es pedir un currentTime
// enorme para forzar al navegador a escanear el archivo y emitir durationchange
// con el valor real. Lo hacemos en un elemento sonda silencioso para no
// interrumpir la reproducción del player visible (la descarga queda cacheada).
function probeDuration(audio: HTMLAudioElement, onResolved: (d: number) => void) {
  const probe = document.createElement("audio");
  probe.preload = "metadata";
  probe.muted = true;
  probe.src = audio.src;
  durationProbes.add(probe);

  const finish = (d: number) => {
    knownDurations.set(audio, d);
    durationProbes.delete(probe);
    probe.removeAttribute("src");
    onResolved(d);
  };

  probe.addEventListener("durationchange", () => {
    if (isFinite(probe.duration) && probe.duration > 0) finish(probe.duration);
  });
  probe.addEventListener("loadedmetadata", () => {
    if (probe.duration === Infinity || isNaN(probe.duration)) {
      probe.currentTime = 1e101; // dispara el escaneo → durationchange real
    } else if (probe.duration > 0) {
      finish(probe.duration);
    }
  });
  probe.addEventListener("error", () => durationProbes.delete(probe));
}

function wireAudio(container: HTMLElement): HTMLAudioElement | null {
  const audio = container.querySelector<HTMLAudioElement>(".audio-el");
  if (!audio) return null;
  if (audioWired.has(audio)) return audio;
  audioWired.add(audio);

  const seek = container.querySelector<HTMLInputElement>(".audio-seek");
  const time = container.querySelector<HTMLElement>(".audio-time");
  const iconPlay = container.querySelector<HTMLElement>(".audio-icon-play");
  const iconPause = container.querySelector<HTMLElement>(".audio-icon-pause");

  const getDuration = () => {
    const known = knownDurations.get(audio);
    if (known && known > 0) return known;
    return isFinite(audio.duration) ? audio.duration : 0;
  };

  const refresh = () => {
    const dur = getDuration();
    if (time)
      time.textContent = `${formatAudioTime(audio.currentTime)} / ${formatAudioTime(dur)}`;
    if (seek) {
      seek.max = String(dur || 0);
      if (dur > 0) seek.value = String(audio.currentTime);
    }
  };

  // Resuelve la duración real cuanto antes (las notas de voz dan Infinity).
  probeDuration(audio, refresh);

  audio.addEventListener("loadedmetadata", refresh);
  audio.addEventListener("timeupdate", refresh);
  audio.addEventListener("play", () => {
    iconPlay?.classList.add("hidden");
    iconPause?.classList.remove("hidden");
  });
  const showPlay = () => {
    iconPlay?.classList.remove("hidden");
    iconPause?.classList.add("hidden");
  };
  audio.addEventListener("pause", showPlay);
  audio.addEventListener("ended", () => {
    audio.currentTime = 0;
    refresh();
    showPlay();
  });
  return audio;
}

// --- Comentarios ---
// Se cargan lazy desde /api/ars/posts/{id}/comments al abrir la sección.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCommentDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  return d.toLocaleDateString("es-CL", { day: "numeric", month: "short", year: "numeric" });
}

function renderComment(c: any): string {
  const user = c?.user || {};
  const name = escapeHtml(user.name || user.username || "Usuario");
  const avatar = typeof user.avatarUrl === "string" ? user.avatarUrl : "";
  const initial = escapeHtml((user.name || user.username || "?").trim().charAt(0).toUpperCase());
  const avatarHtml = avatar
    ? `<img src="${escapeHtml(avatar)}" class="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-slate-700 ring-1 ring-black/5 dark:ring-white/10 shrink-0" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;w-7 h-7 rounded-full bg-gray-200 dark:bg-slate-700 ring-1 ring-black/5 dark:ring-white/10 flex items-center justify-center text-[10px] font-bold text-gray-500 dark:text-slate-200 shrink-0&quot;>${initial}</div>'" />`
    : `<div class="w-7 h-7 rounded-full bg-gray-200 dark:bg-slate-700 ring-1 ring-black/5 dark:ring-white/10 flex items-center justify-center text-[10px] font-bold text-gray-500 dark:text-slate-200 shrink-0">${initial}</div>`;
  const likes = Number(c?.likesCount) || 0;
  const likesHtml = likes > 0 ? `<span class="text-[10px] text-gray-400 dark:text-slate-500 ml-2">♥ ${likes}</span>` : "";
  return `
    <div class="flex items-start gap-2">
      ${avatarHtml}
      <div class="min-w-0 flex-1">
        <p class="text-xs leading-tight">
          <span class="font-bold text-gray-900 dark:text-slate-100">${name}</span>
          <span class="text-gray-400 dark:text-slate-500 ml-1">${escapeHtml(formatCommentDate(c?.createdAt || ""))}</span>
          ${likesHtml}
        </p>
        <p class="text-sm text-gray-800 dark:text-slate-100 whitespace-pre-wrap break-words mt-0.5">${escapeHtml(c?.text || "")}</p>
      </div>
    </div>`;
}

async function loadComments(section: HTMLElement, page: number) {
  if (section.dataset.loading === "1") return;
  section.dataset.loading = "1";
  const postId = section.dataset.postId;
  const list = section.querySelector<HTMLElement>(".comments-list");
  const status = section.querySelector<HTMLElement>(".comments-status");
  const moreBtn = section.querySelector<HTMLElement>(".comments-more");
  if (status) {
    status.textContent = "Cargando comentarios…";
    status.classList.remove("hidden");
  }
  moreBtn?.classList.add("hidden");

  try {
    const res = await fetch(`/api/ars/posts/${postId}/comments?page=${page}&limit=10`);
    const data = await res.json();
    if (!res.ok || !data?.success) throw new Error(data?.error || `HTTP ${res.status}`);

    const comments: any[] = Array.isArray(data.comments) ? data.comments : [];
    if (list) list.insertAdjacentHTML("beforeend", comments.map(renderComment).join(""));
    section.dataset.page = String(page);

    if (status) {
      if (page === 1 && comments.length === 0) {
        status.textContent = "Sin comentarios todavía";
      } else {
        status.classList.add("hidden");
      }
    }
    if (data.hasMore) moreBtn?.classList.remove("hidden");
  } catch {
    if (status) {
      status.textContent = "No se pudieron cargar los comentarios";
      status.classList.remove("hidden");
    }
    // Permite reintentar al volver a abrir/pedir más.
    if (page === 1) delete section.dataset.loaded;
  } finally {
    delete section.dataset.loading;
  }
}

function onClick(e: MouseEvent) {
  const target = e.target as HTMLElement;

  // Comentarios: toggle de la sección (carga lazy la primera vez)
  const commentsToggle = target.closest<HTMLElement>(".comments-toggle");
  if (commentsToggle) {
    e.preventDefault();
    e.stopPropagation();
    const section = commentsToggle
      .closest(".post-card")
      ?.querySelector<HTMLElement>(".comments-section");
    if (section) {
      section.classList.toggle("hidden");
      if (!section.classList.contains("hidden") && section.dataset.loaded !== "1") {
        section.dataset.loaded = "1";
        loadComments(section, 1);
      }
    }
    return;
  }

  // Comentarios: paginación
  const commentsMore = target.closest<HTMLElement>(".comments-more");
  if (commentsMore) {
    e.preventDefault();
    e.stopPropagation();
    const section = commentsMore.closest<HTMLElement>(".comments-section");
    if (section) loadComments(section, (Number(section.dataset.page) || 1) + 1);
    return;
  }

  // 0. Reproducir / pausar nota de voz
  const audioBtn = target.closest<HTMLElement>(".audio-play");
  if (audioBtn) {
    e.preventDefault();
    e.stopPropagation();
    const container = audioBtn.closest<HTMLElement>(".audio-player");
    const audio = container && wireAudio(container);
    if (audio) {
      if (audio.paused) {
        // Un solo audio a la vez en toda la página.
        document
          .querySelectorAll<HTMLAudioElement>(".audio-el")
          .forEach((a) => a !== audio && a.pause());
        audio.play().catch(() => {});
      } else {
        audio.pause();
      }
    }
    return;
  }

  // 1. Toggle JSON raw
  const jsonBtn = target.closest<HTMLButtonElement>(".json-toggle");
  if (jsonBtn) {
    e.preventDefault();
    e.stopPropagation();
    const pre = jsonBtn.closest(".post-card")?.querySelector(".json-content");
    if (pre) {
      pre.classList.toggle("hidden");
      jsonBtn.textContent = pre.classList.contains("hidden")
        ? "Ver JSON Raw"
        : "Ocultar JSON Raw";
    }
    return;
  }

  // 2. Link al perfil (avatar/nombre)
  const profileLink = target.closest<HTMLElement>("[data-profile-link]");
  if (profileLink) {
    e.preventDefault();
    e.stopPropagation();
    window.location.href = `/ars/${profileLink.dataset.profileLink}`;
    return;
  }

  // 4. Reproducir video del feed
  const poster = target.closest<HTMLElement>(".video-poster");
  if (poster) {
    e.preventDefault();
    e.stopPropagation();
    // Si venimos de un "mantener presionado" (mobile), sólo se cargó la
    // duración: no reproducimos en este tap.
    if (suppressNextPlay) {
      suppressNextPlay = false;
      return;
    }
    playFeedVideo(poster);
    return;
  }

  // 5. Abrir imagen en lightbox
  const image = target.closest<HTMLElement>(".post-image");
  if (image) {
    e.preventDefault();
    e.stopPropagation();
    (window as any).openLightbox?.(image.dataset.src);
    return;
  }

  // 6. No navegar al hacer click en controles/elementos interactivos
  if (
    target.closest(
      "button, a, video, input, select, .audio-player, .video-player-container, .video-wrapper, .json-content, .comments-section",
    )
  ) {
    return;
  }

  // 7. Navegación de la card
  const card = target.closest<HTMLElement>(".post-card");
  if (card && card.dataset.isDetail !== "true") {
    const pid = card.dataset.postId;
    const u = card.dataset.username;
    if (pid && u) window.location.href = `/ars/${u}/post/${pid}`;
  }
}

// Seek de la nota de voz (el evento `input` del range sí burbujea).
function onInput(e: Event) {
  const seek = (e.target as HTMLElement).closest<HTMLInputElement>(".audio-seek");
  if (!seek) return;
  const container = seek.closest<HTMLElement>(".audio-player");
  const audio = container && wireAudio(container);
  // No usamos audio.duration: en los webm de voz es Infinity. El propio
  // <audio> recorta el valor al rango real.
  const t = Number(seek.value);
  if (audio && isFinite(t)) audio.currentTime = t;
}

// Velocidad de reproducción de la nota de voz.
function onChange(e: Event) {
  const sel = (e.target as HTMLElement).closest(
    ".audio-speed",
  ) as HTMLSelectElement | null;
  if (!sel) return;
  const container = sel.closest<HTMLElement>(".audio-player");
  const audio = container && wireAudio(container);
  if (audio) audio.playbackRate = Number(sel.value);
}

function onMouseOver(e: MouseEvent) {
  const poster = (e.target as HTMLElement).closest<HTMLElement>(".video-poster");
  if (poster) loadDuration(poster);
}

// --- Touch: mantener presionado carga la duración (equivalente al hover);
// un tap corto reproduce. ---
const HOLD_MS = 250; // umbral para considerar "mantener presionado"
let holdTimer: ReturnType<typeof setTimeout> | null = null;
// Cuando un hold ya cargó la duración, el click posterior NO debe reproducir.
let suppressNextPlay = false;

function clearHoldTimer() {
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
}

function onTouchStart(e: TouchEvent) {
  const poster = (e.target as HTMLElement).closest<HTMLElement>(".video-poster");
  suppressNextPlay = false;
  clearHoldTimer();
  if (!poster) return;
  holdTimer = setTimeout(() => {
    loadDuration(poster);
    suppressNextPlay = true; // fue hold: el tap no reproduce, sólo muestra duración
    holdTimer = null;
  }, HOLD_MS);
}

// Si el dedo se mueve (scroll) cancelamos el hold para no cargar nada.
function onTouchMove() {
  clearHoldTimer();
}

function onTouchEnd() {
  clearHoldTimer();
}

function onKeyDown(e: KeyboardEvent) {
  // Ctrl/Cmd+A dentro de un bloque JSON: selecciona solo su contenido en lugar
  // de toda la página.
  if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey)) {
    const pre = (e.target as HTMLElement)?.closest?.(".json-content");
    if (pre) {
      e.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(pre);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    return;
  }

  if (e.key !== "Enter" && e.key !== " ") return;
  const card = (e.target as HTMLElement).closest<HTMLElement>(".post-card");
  if (card && card.dataset.isDetail !== "true" && e.target === card) {
    const pid = card.dataset.postId;
    const u = card.dataset.username;
    if (pid && u) {
      e.preventDefault();
      window.location.href = `/ars/${u}/post/${pid}`;
    }
  }
}

let initialized = false;
export function initPostCards() {
  if (initialized) return;
  initialized = true;
  document.addEventListener("click", onClick);
  document.addEventListener("input", onInput);
  document.addEventListener("change", onChange);
  document.addEventListener("mouseover", onMouseOver);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("touchstart", onTouchStart, { passive: true });
  document.addEventListener("touchmove", onTouchMove, { passive: true });
  document.addEventListener("touchend", onTouchEnd, { passive: true });
}

// Inicializa los players de la página de detalle (preload manual al entrar en
// viewport, para no descargar segmentos hasta que el usuario reproduzca).
export function initDetailVideos(root: Document | HTMLElement = document) {
  const videos = root.querySelectorAll<HTMLVideoElement>("video.detail-video");
  videos.forEach((video) => {
    if (hlsByVideo.has(video) || video.src) return;
    const src = video.dataset.hlsSrc;
    if (!src) return;
    const mime = video.dataset.mime || "";
    // No autoplay: el usuario controla. setupVideo deja HLS listo para el play.
    setupVideo(video, src, mime, false);
  });
}
