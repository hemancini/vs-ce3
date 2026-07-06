// Carga los JSON de feeds capturados por creador (src/data/ars/feeds/<username>.json)
// en tiempo de build mediante `import.meta.glob`, sin tocar el filesystem en
// runtime (node:fs). Así funciona también en runtimes sin acceso a disco.
//
// El scraper (scripts/arsmate-admin-browser.mjs) deja los JSON crudos en
// scripts/output/; aquí se consume la copia versionada en src/data/ars/feeds/, un
// archivo por creador.

export interface RawFeedFile {
  creatorInfo: { id: number; username: string; endDate?: string };
  posts: any[];
}

// `eager: true` => los JSON se incluyen en el bundle y quedan disponibles de
// forma síncrona. Cada módulo expone el objeto parseado en `.default`.
const modules = import.meta.glob<{ default: RawFeedFile }>(
  "../../data/ars/feeds/*.json",
  { eager: true },
);

let cache: RawFeedFile[] | null = null;

/** Devuelve todos los feeds crudos (creatorInfo + posts) ordenados por username. */
export function getRawFeedFiles(): RawFeedFile[] {
  if (cache) return cache;

  const feeds = Object.values(modules)
    .map((m) => m.default)
    .filter((f): f is RawFeedFile => !!f && Array.isArray(f.posts));

  feeds.sort((a, b) =>
    (a.creatorInfo?.username || "").localeCompare(b.creatorInfo?.username || ""),
  );

  return (cache = feeds);
}
