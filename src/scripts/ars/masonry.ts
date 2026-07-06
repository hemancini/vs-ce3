// Masonry por columnas en JS.
//
// A diferencia de CSS `columns` (que rebalancea y reordena las cards ya
// pintadas cada vez que se inserta contenido nuevo), aquí cada card se asigna a
// la columna más corta en el momento de insertarse y permanece ahí: el
// contenido nuevo siempre se añade al final, sin mover lo ya cargado.
//
// Solo se re-maqueta cuando cambia el número de columnas (cruce de breakpoint).

export interface Masonry {
  /** Coloca una card en la columna más corta y la recuerda como "última". */
  place(card: HTMLElement): void;
  /** Reparte una lista ordenada de cards desde cero (SSR inicial / filtros). */
  layout(cards: HTMLElement[]): void;
  /** Vacía todas las columnas. */
  clear(): void;
  /** Cards colocadas, en orden de inserción. */
  readonly cards: HTMLElement[];
}

export function createMasonry(
  container: HTMLElement,
  colCountFn: () => number,
): Masonry {
  const ordered: HTMLElement[] = [];
  let cols: HTMLElement[] = [];
  let colCount = 0;

  // CSS `columns` queda anulado al volver el contenedor un flex de columnas.
  container.classList.remove("columns-1", "sm:columns-2", "columns-2");
  container.classList.add("flex", "items-start", "gap-6");

  function build(n: number) {
    colCount = n;
    cols = [];
    container.replaceChildren();
    for (let i = 0; i < n; i++) {
      const col = document.createElement("div");
      col.className = "flex-1 min-w-0 flex flex-col gap-6";
      container.appendChild(col);
      cols.push(col);
    }
  }

  function shortest(): HTMLElement {
    let best = cols[0];
    for (let i = 1; i < cols.length; i++) {
      if (cols[i].offsetHeight < best.offsetHeight) best = cols[i];
    }
    return best;
  }

  function place(card: HTMLElement) {
    if (cols.length === 0) build(colCountFn());
    shortest().appendChild(card);
    ordered.push(card);
  }

  function layout(cards: HTMLElement[]) {
    ordered.length = 0;
    build(colCountFn());
    for (const card of cards) {
      shortest().appendChild(card);
      ordered.push(card);
    }
  }

  function clear() {
    ordered.length = 0;
    build(colCountFn());
  }

  // Re-maquetar solo si cambia el número de columnas (no en cada resize).
  let resizeTimer: number | undefined;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (colCountFn() !== colCount) layout(ordered.slice());
    }, 150);
  });

  return {
    place,
    layout,
    clear,
    get cards() {
      return ordered;
    },
  };
}

/** Nº de columnas según el breakpoint `sm` de Tailwind (640px). */
export function responsiveColumns(): number {
  return window.matchMedia("(min-width: 640px)").matches ? 2 : 1;
}

/** Extrae las cards (`.post-card`) de un fragmento HTML, en orden. */
export function parseCards(html: string): HTMLElement[] {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  return Array.from(
    tpl.content.querySelectorAll<HTMLElement>(".post-card[data-post-id]"),
  );
}
