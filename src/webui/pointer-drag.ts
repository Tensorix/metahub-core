// Shared pointer-drag machinery for the table grid, board cards, the editor's
// table block, and drop-mark bookkeeping. Wraps the recurring pattern:
// pointerdown → 4px activation threshold → ghost / body-class bookkeeping on
// move → listener cleanup and commit on pointerup/cancel. Callers own the
// semantics (what a drop means); this module owns the wiring.

export type DropWhere = "before" | "after";

export interface PointerDownLike {
  pointerId: number;
  clientX: number;
  clientY: number;
}

export interface DragCallbacks {
  /** Distance (px) the pointer must travel before the drag activates.
   *  0 = active from the first move (resize handles). Default 4. */
  threshold?: number;
  /** Fired once, when the threshold is crossed. */
  onStart?: (e: PointerEvent) => void;
  /** Fired for every move while active (after preventDefault). */
  onMove: (e: PointerEvent) => void;
  /** Always fired once after listeners are removed; `active` distinguishes a
   *  real drag (true) from a plain click that never crossed the threshold. */
  onEnd?: (e: PointerEvent, active: boolean) => void;
}

export function startPointerDrag(down: PointerDownLike, cb: DragCallbacks): void {
  const threshold = cb.threshold ?? 4;
  let active = threshold === 0;
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== down.pointerId) return;
    if (!active) {
      if (Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) < threshold) return;
      active = true;
      cb.onStart?.(ev);
    }
    ev.preventDefault();
    cb.onMove(ev);
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== down.pointerId) return;
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", up);
    cb.onEnd?.(ev, active);
  };
  addEventListener("pointermove", move, { passive: false });
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
}

// ---- drop-mark helpers -------------------------------------------------------
// Only one drag runs at a time, so a single global clear covers every consumer
// (table rows/columns, board columns, sidebar tree, editor blocks).

export function clearDropMarks(): void {
  document
    .querySelectorAll(".drop-into,.drop-before,.drop-after")
    .forEach((n) => n.classList.remove("drop-into", "drop-before", "drop-after"));
}

/** Mark `el` as the drop target: before/after its midpoint along `axis`. */
export function markDropHalf(
  el: HTMLElement,
  e: { clientX: number; clientY: number },
  axis: "x" | "y",
): DropWhere {
  clearDropMarks();
  const r = el.getBoundingClientRect();
  const where: DropWhere =
    axis === "y"
      ? e.clientY < r.top + r.height / 2 ? "before" : "after"
      : e.clientX < r.left + r.width / 2 ? "before" : "after";
  el.classList.add("drop-" + where);
  return where;
}

// ---- ghost helpers -----------------------------------------------------------

export function createDragGhost(cls: string, rect: DOMRect, text: string): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost " + cls;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.textContent = text;
  document.body.appendChild(ghost);
  return ghost;
}

export function positionGhost(el: HTMLElement | null, left: number, top: number): void {
  if (!el) return;
  el.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
}

// ---- composed drags ----------------------------------------------------------

/** Grip-handle drag with a floating text ghost and before/after drop marking —
 *  the table grid's row and column reorder are this with different axes. */
export function startGhostDrag(
  down: PointerDownLike,
  opts: {
    source: HTMLElement;
    axis: "x" | "y";
    ghostCls: string;
    ghostText: string;
    /** Candidate drop targets (closest() selector from the pointer position). */
    targetSelector: string;
    /** Dragging over the source itself clears the mark instead of targeting. */
    isSelf: (el: HTMLElement) => boolean;
    onActivate?: () => void;
    onDrop: (target: HTMLElement, where: DropWhere) => void;
    onFinish?: (active: boolean) => void;
  },
): void {
  const rect = opts.source.getBoundingClientRect();
  const offX = down.clientX - rect.left;
  const offY = down.clientY - rect.top;
  let ghost: HTMLElement | null = null;
  let target: HTMLElement | null = null;
  let where: DropWhere = "before";
  startPointerDrag(down, {
    onStart: () => {
      ghost = createDragGhost(opts.ghostCls, rect, opts.ghostText);
      opts.source.classList.add("drag-source");
      document.body.classList.add("table-dragging");
      opts.onActivate?.();
    },
    onMove: (ev) => {
      positionGhost(ghost, ev.clientX - offX, ev.clientY - offY);
      const el = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest?.(opts.targetSelector) as HTMLElement | null;
      if (!el || opts.isSelf(el)) {
        clearDropMarks();
        target = null;
        return;
      }
      target = el;
      where = markDropHalf(el, ev, opts.axis);
    },
    onEnd: (_ev, active) => {
      ghost?.remove();
      opts.source.classList.remove("drag-source");
      document.body.classList.remove("table-dragging");
      clearDropMarks();
      if (active && target) opts.onDrop(target, where);
      opts.onFinish?.(active);
    },
  });
}

/** rAF-throttled column-width resize: writes the <col> width directly during
 *  the drag (table-layout: fixed reflows 1:1 with the cursor) and reports the
 *  final width once on release — never re-renders per pointermove. */
export function startColumnResize(
  down: PointerDownLike & { currentTarget: EventTarget | null },
  opts: { col: HTMLElement | null; startWidth: number; min: number; onDone: (w: number) => void },
): void {
  const handle = down.currentTarget as HTMLElement;
  let last = opts.startWidth;
  let raf = 0;
  handle.classList.add("dragging");
  document.body.classList.add("col-resizing");
  startPointerDrag(down, {
    threshold: 0,
    onMove: (ev) => {
      last = Math.max(opts.min, opts.startWidth + ev.clientX - down.clientX);
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (opts.col) opts.col.style.width = last + "px";
        });
    },
    onEnd: () => {
      if (raf) cancelAnimationFrame(raf);
      if (opts.col) opts.col.style.width = last + "px";
      handle.classList.remove("dragging");
      document.body.classList.remove("col-resizing");
      opts.onDone(last);
    },
  });
}
