/** @jsxImportSource preact */
// A GFM pipe table rendered as a real <table> of contentEditable cells. Cell
// edits are uncontrolled (innerHTML rewritten only on a structural re-render, via
// renderKey) so typing never resets the caret — same pattern as the .editable /
// CodeBlock hosts. Structural ops (add/del row & col, alignment) go through
// onTableChange → bump(). Column widths are session-only: kept in a ref and
// written straight onto the <col> elements, never serialized to Markdown.
// Until the user drags a resizer the table is in autofit mode — no <col>
// widths, browser auto table layout sizes columns by content (capped to the
// wrap, see .doc-table.autofit) — and the first drag freezes the measured
// widths into the ref and switches to the fixed-layout manual mode below.
import { useEffect, useRef, useState } from "preact/hooks";
import type { Block, ColAlign } from "../blocks.ts";
import { Icon } from "../icons.tsx";
import { openMenu, MenuItem, MenuLabel, MenuSep } from "../ui.tsx";
import { inlineToHtml, htmlToInline } from "../markdown.tsx";
import { startColumnResize, startPointerDrag } from "../pointer-drag.ts";
import { type CellSel, normRect, inRect, edgeShadow, clearRect, selectionToTsv } from "../cell-select.ts";

// Touch (no hover): the active cell is the focused one (focusin) instead of
// the hovered one, step-move menu items back up drag-reorder, and the cell
// rectangle gets an on-screen action bar. Evaluated once — a device's pointer
// class doesn't change mid-session.
const COARSE = typeof matchMedia !== "undefined" && matchMedia("(hover: none)").matches;

// Focus the contentEditable cell at (r, c) under `root` and drop the caret at
// its end. Shared by the in-table Tab/Enter navigation and the cell-rectangle
// keyboard layer's Enter/F2 "start editing" (void-field.tsx TableHost).
export function focusCellEnd(root: ParentNode, r: number, c: number): boolean {
  const el = root.querySelector<HTMLElement>(`.doc-td[data-r="${r}"][data-c="${c}"]`);
  if (!el) return false;
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const s = getSelection();
  s?.removeAllRanges();
  s?.addRange(range);
  return true;
}

export function TableBlock({
  block, renderKey, onCellInput, onTableChange, cellSel, onCellSel,
}: {
  block: Block;
  renderKey: number;
  onCellInput: (r: number, c: number, value: string) => void;
  onTableChange: () => void;
  cellSel: CellSel | null;
  onCellSel: (sel: CellSel | null) => void;
}) {
  const rows = block.rows ?? [];
  const cols = rows[0]?.length ?? 0;
  const align = block.align ?? [];
  const tableRef = useRef<HTMLTableElement>(null);
  const rect = cellSel ? normRect(cellSel) : null;
  const widths = useRef<number[]>([]);
  const [manual, setManual] = useState(false);
  // Manual mode only: keep the session-only width array sized to the column
  // count; new columns inherit the default, existing widths survive re-renders.
  if (manual && widths.current.length !== cols) {
    widths.current = Array.from({ length: cols }, (_, c) => widths.current[c] ?? 160);
  }

  const addRow = () => { block.rows = [...rows, new Array(cols).fill("")]; onTableChange(); };
  const addCol = () => {
    block.rows = rows.map((r) => [...r, ""]);
    block.align = [...align, null];
    onTableChange();
  };
  const insertCol = (at: number) => {
    block.rows = rows.map((r) => { const n = [...r]; n.splice(at, 0, ""); return n; });
    const a = [...align]; a.splice(at, 0, null); block.align = a;
    onTableChange();
  };
  const deleteCol = (c: number) => {
    if (cols <= 1) return;
    block.rows = rows.map((r) => r.filter((_, i) => i !== c));
    block.align = align.filter((_, i) => i !== c);
    onTableChange();
  };
  const deleteRow = (r: number) => {
    if (r === 0 || rows.length <= 2) return; // keep the header + at least one body row
    block.rows = rows.filter((_, i) => i !== r);
    onTableChange();
  };
  const insertRow = (at: number) => {
    if (at < 1) return; // never above the header
    const n = [...rows];
    n.splice(at, 0, new Array(cols).fill(""));
    block.rows = n;
    onTableChange();
  };
  const duplicateRow = (r: number) => {
    const n = [...rows];
    n.splice(r + 1, 0, [...(rows[r] ?? [])]);
    block.rows = n;
    onTableChange();
  };
  const duplicateCol = (c: number) => {
    block.rows = rows.map((row) => { const n = [...row]; n.splice(c + 1, 0, row[c] ?? ""); return n; });
    const a = Array.from({ length: cols }, (_, i) => align[i] ?? null);
    a.splice(c + 1, 0, align[c] ?? null);
    block.align = a;
    onTableChange();
  };
  // Move to an arbitrary boundary: `to` is an insertion index in the pre-splice
  // array ("insert before rows[to]"), so to===from and to===from+1 are no-ops.
  // One call = one onTableChange = one undo step — drag drops and the menu's
  // step moves both land here.
  const moveRowTo = (from: number, to: number) => {
    if (from < 1 || to < 1 || to > rows.length || to === from || to === from + 1) return; // header pinned
    const n = [...rows];
    const [row] = n.splice(from, 1);
    n.splice(to > from ? to - 1 : to, 0, row!);
    block.rows = n;
    onTableChange();
  };
  const moveColTo = (from: number, to: number) => {
    if (to < 0 || to > cols || to === from || to === from + 1) return;
    const dst = to > from ? to - 1 : to;
    block.rows = rows.map((row) => { const n = [...row]; const [v] = n.splice(from, 1); n.splice(dst, 0, v ?? ""); return n; });
    const a = Array.from({ length: cols }, (_, i) => align[i] ?? null);
    const [av] = a.splice(from, 1);
    a.splice(dst, 0, av ?? null);
    block.align = a;
    if (manual) { // session column widths are positional — travel with the column
      const w = [...widths.current];
      const [wv] = w.splice(from, 1);
      w.splice(dst, 0, wv ?? 160);
      widths.current = w;
    }
    onTableChange();
  };
  const setAlign = (c: number, a: ColAlign) => {
    const next = Array.from({ length: cols }, (_, i) => align[i] ?? null);
    next[c] = a;
    block.align = next;
    onTableChange();
  };

  // Move focus by (dr, dc) within this table; returns false if out of bounds.
  const focusCell = (r: number, c: number): boolean =>
    tableRef.current ? focusCellEnd(tableRef.current, r, c) : false;

  const onCellKeyDown = (e: KeyboardEvent, r: number, c: number) => {
    if (e.isComposing || e.keyCode === 229) return; // IME: Enter/Tab confirm the candidate, not the cell
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        if (c > 0) focusCell(r, c - 1);
        else if (r > 0) focusCell(r - 1, cols - 1);
      } else {
        if (c < cols - 1) focusCell(r, c + 1);
        else if (r < rows.length - 1) focusCell(r + 1, 0);
        else { addRow(); requestAnimationFrame(() => focusCell(rows.length, 0)); }
      }
      return;
    }
    if (e.key === "Enter") {
      // Cells are single-line; Enter steps to the row below instead of inserting a <br>.
      e.preventDefault();
      if (r < rows.length - 1) focusCell(r + 1, c);
      else { addRow(); requestAnimationFrame(() => focusCell(rows.length, c)); }
      return;
    }
  };

  // Box-select cells. A plain pointer-down keeps the click intent (drop a caret
  // to edit) and only promotes to a cell selection once the pointer crosses into
  // a *different* cell — mirroring the editor's text→block drag promotion. Once
  // promoted we blur the editable and drop the native range so the rectangle
  // owns the keyboard. Shift+click extends from the existing anchor.
  const startCellSelect = (e: PointerEvent, r: number, c: number) => {
    // Let the handles / resizer / add buttons run their own pointer logic.
    if ((e.target as HTMLElement).closest("button,a,.doc-col-resizer")) return;
    const dropEdit = () => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      getSelection()?.removeAllRanges();
    };
    // Touch: a drag must stay a scroll (and box-select drags would fight it),
    // so selection enters spreadsheet-style instead — a ~350ms long-press
    // selects the cell; the fill handle (touch-action:none) then grows the
    // rectangle. The timer fires BEFORE iOS's own long-press text selection,
    // and dropEdit() clears whatever native selection got started; the
    // one-shot click squelch keeps the release tap from refocusing the cell.
    if (e.pointerType === "touch") {
      if (cellSel) onCellSel(null); // a tap dismisses a prior rectangle (mirrors the mouse path below)
      const x = e.clientX, y = e.clientY, pid = e.pointerId;
      let fired = false;
      const stop = () => {
        clearTimeout(timer);
        removeEventListener("pointermove", onMove);
        removeEventListener("pointerup", onUp);
        removeEventListener("pointercancel", onUp);
      };
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pid || fired) return;
        if (Math.hypot(ev.clientX - x, ev.clientY - y) > 6) stop(); // it's a scroll — stand down
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        stop();
        if (!fired) return;
        // Swallow only the click synthesized from THIS release (it would
        // refocus the cell and pop the OSK over the fresh selection); disarm
        // right after so the next real tap — e.g. the action bar — lands.
        const squelch = (ce: MouseEvent) => { ce.preventDefault(); ce.stopPropagation(); disarm(); };
        const disarm = () => removeEventListener("click", squelch, true);
        addEventListener("click", squelch, true);
        setTimeout(disarm, 400);
      };
      const timer = setTimeout(() => {
        fired = true; // hold the listeners: the release tap still needs squelching
        dropEdit();
        onCellSel({ a: { r, c }, b: { r, c } });
      }, 350);
      addEventListener("pointermove", onMove);
      addEventListener("pointerup", onUp);
      addEventListener("pointercancel", onUp);
      return;
    }
    if (e.button !== 0) return;
    if (e.shiftKey && cellSel) {
      e.preventDefault();
      dropEdit();
      const anchor = cellSel.a;
      onCellSel({ a: anchor, b: { r, c } });
      startPointerDrag(e, {
        onMove: (ev) => {
          const td = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".doc-td") as HTMLElement | null;
          if (!td || td.dataset.r == null) return;
          onCellSel({ a: anchor, b: { r: Number(td.dataset.r), c: Number(td.dataset.c) } });
        },
      });
      return;
    }
    const anchor = { r, c };
    let promoted = false;
    startPointerDrag(e, {
      onMove: (ev) => {
        const td = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".doc-td") as HTMLElement | null;
        if (!td || td.dataset.r == null) return;
        const tr = Number(td.dataset.r), tc = Number(td.dataset.c);
        if (!promoted) {
          if (tr === anchor.r && tc === anchor.c) return; // still in the anchor cell → keep editing intent
          promoted = true;
          dropEdit();
          document.body.classList.add("cell-selecting");
        }
        onCellSel({ a: anchor, b: { r: tr, c: tc } });
      },
      onEnd: () => document.body.classList.remove("cell-selecting"),
    });
    // A pointer-down inside a cell dismisses a prior selection; if it turns into
    // a drag the onMove above re-establishes one.
    if (cellSel) onCellSel(null);
  };

  // Drag the bottom-right fill handle to grow/shrink the rectangle: the
  // selection's top-left stays anchored and the focus follows the pointer (so
  // dragging up/left shrinks, down/right grows). threshold:0 starts immediately.
  const startHandleDrag = (e: PointerEvent) => {
    if (!rect) return;
    e.preventDefault();
    e.stopPropagation(); // don't let the cell's startCellSelect clear the selection
    const anchor = { r: rect.r0, c: rect.c0 };
    (document.activeElement as HTMLElement | null)?.blur?.();
    getSelection()?.removeAllRanges();
    startPointerDrag(e, {
      threshold: 0,
      onStart: () => document.body.classList.add("cell-selecting"),
      onMove: (ev) => {
        const td = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".doc-td") as HTMLElement | null;
        if (!td || td.dataset.r == null) return;
        onCellSel({ a: anchor, b: { r: Number(td.dataset.r), c: Number(td.dataset.c) } });
      },
      onEnd: () => document.body.classList.remove("cell-selecting"),
    });
  };

  const startResize = (e: PointerEvent, c: number) => {
    e.preventDefault();
    e.stopPropagation();
    const table = tableRef.current;
    if (!table) return;
    if (!manual) {
      // First drag: freeze the auto layout's measured widths so the drag has a
      // stable fixed-layout baseline. All synchronous DOM writes (widths onto
      // the <col>s, drop the autofit class) so the drag origin doesn't jump;
      // setManual just makes the next render agree with the DOM.
      const cells = table.tBodies[0]?.rows[0]?.cells;
      if (!cells) return;
      widths.current = Array.from({ length: cols }, (_, i) => cells[i]?.offsetWidth ?? 160);
      table.querySelectorAll<HTMLElement>("col[data-tcol]").forEach((col, i) => {
        col.style.width = (widths.current[i] ?? 160) + "px";
      });
      table.classList.remove("autofit");
      setManual(true);
    }
    startColumnResize(e, {
      col: table.querySelector<HTMLElement>(`col[data-tcol="${c}"]`),
      startWidth: widths.current[c] ?? 160,
      min: 60,
      onDone: (w) => { widths.current[c] = w; },
    });
  };

  // Shared menu fragments: the row and column pill handles open these (click =
  // menu, drag = reorder). r/c are captured when the menu opens, so later
  // focus/hover changes can't retarget an open menu. Items that would be
  // silent no-ops simply don't render. The step-move items are the touch
  // fallback for drag-reorder, so they render on coarse pointers only.
  const colMenuItems = (c: number, close: () => void) => (
    <>
      <MenuLabel>对齐方式</MenuLabel>
      <MenuItem icon="alignLeft" label="左对齐" checked={(align[c] ?? null) === null || align[c] === "left"} onClick={() => { setAlign(c, "left"); close(); }} />
      <MenuItem icon="alignCenter" label="居中" checked={align[c] === "center"} onClick={() => { setAlign(c, "center"); close(); }} />
      <MenuItem icon="alignRight" label="右对齐" checked={align[c] === "right"} onClick={() => { setAlign(c, "right"); close(); }} />
      <MenuSep />
      <MenuItem icon="plus" label="在左侧插入列" onClick={() => { insertCol(c); close(); }} />
      <MenuItem icon="cornerUpRight" label="在右侧插入列" onClick={() => { insertCol(c + 1); close(); }} />
      <MenuItem icon="copy" label="复制列" onClick={() => { duplicateCol(c); close(); }} />
      {COARSE && c > 0 && <MenuItem icon="arrowLeft" label="左移列" onClick={() => { moveColTo(c, c - 1); close(); }} />}
      {COARSE && c < cols - 1 && <MenuItem icon="chevron" label="右移列" onClick={() => { moveColTo(c, c + 2); close(); }} />}
      {cols > 1 && <MenuItem icon="trash" label="删除列" danger onClick={() => { deleteCol(c); close(); }} />}
    </>
  );
  const rowMenuItems = (r: number, close: () => void) => (
    <>
      {r >= 1 && <MenuItem icon="plus" label="在上方插入行" onClick={() => { insertRow(r); close(); }} />}
      <MenuItem icon="cornerUpRight" label="在下方插入行" onClick={() => { insertRow(r + 1); close(); }} />
      {r > 0 && <MenuItem icon="copy" label="复制行" onClick={() => { duplicateRow(r); close(); }} />}
      {COARSE && r > 1 && <MenuItem icon="arrowUp" label="上移行" onClick={() => { moveRowTo(r, r - 1); close(); }} />}
      {COARSE && r >= 1 && r < rows.length - 1 && <MenuItem icon="chevronDown" label="下移行" onClick={() => { moveRowTo(r, r + 2); close(); }} />}
      {r > 0 && rows.length > 2 && <MenuItem icon="trash" label="删除行" danger onClick={() => { deleteRow(r); close(); }} />}
    </>
  );

  // ---- active cell + pill handles ------------------------------------------
  // One "active cell" drives both handles: the hovered cell on desktop
  // (mousemove), the focused cell on touch (focusin — no hover there). The row
  // pill straddles the row's left border, the column pill the column's top
  // border, both on the wrap layer OUTSIDE .doc-table-scroll so overflow-x
  // can't clip them. Data rows only get a row pill (the block gutter's +/grip
  // pins at the table's top edge — the header row's y). The column pill's x
  // follows horizontal scroll (onScroll re-measures) and hides once the
  // column's center leaves the scrollport.
  const wrapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  type Active = { r: number; c: number; rowTop: number; colX: number; colOn: boolean };
  const [active, setActive] = useState<Active | null>(null);
  useEffect(() => setActive(null), [renderKey]); // geometry may have changed
  const measureActive = (r: number, c: number): Active | null => {
    const wrap = wrapRef.current, table = tableRef.current;
    const tr = table?.tBodies[0]?.rows[r], td = tr?.cells[c];
    if (!wrap || !tr || !td) return null;
    const wr = wrap.getBoundingClientRect();
    const trr = tr.getBoundingClientRect();
    const tdr = td.getBoundingClientRect();
    const rowTop = Math.round(trr.top - wr.top + (trr.height - 28) / 2);
    const colX = Math.round(tdr.left + tdr.width / 2 - wr.left);
    return { r, c, rowTop, colX, colOn: colX >= 10 && colX <= wr.width - 10 };
  };
  const retrack = (r: number, c: number) =>
    setActive((prev) => {
      const a = measureActive(r, c);
      return prev && a && prev.r === a.r && prev.c === a.c && prev.rowTop === a.rowTop && prev.colX === a.colX && prev.colOn === a.colOn ? prev : a;
    });
  const trackCell = (e: MouseEvent) => {
    if (document.body.classList.contains("table-dragging")) return; // grid idiom: no retarget mid-drag
    const td = (e.target as HTMLElement).closest?.(".doc-td") as HTMLElement | null;
    if (!td || td.dataset.r == null || !wrapRef.current?.contains(td)) return;
    retrack(Number(td.dataset.r), Number(td.dataset.c));
  };
  // Touch: the focused cell is the active cell. contentEditable cells are
  // uncontrolled (innerHTML untouched while renderKey is stable), so the
  // re-render this triggers cannot disturb the caret.
  useEffect(() => {
    if (!COARSE) return;
    const table = tableRef.current;
    if (!table) return;
    const onFocusIn = (e: FocusEvent) => {
      const td = (e.target as HTMLElement).closest?.(".doc-td") as HTMLElement | null;
      if (td?.dataset.r != null) retrack(Number(td.dataset.r), Number(td.dataset.c));
    };
    const onFocusOut = () => {
      requestAnimationFrame(() => {
        const ae = document.activeElement as HTMLElement | null;
        if (!table.contains(ae) && !ae?.closest?.(".doc-row-handle,.doc-col-handle")) setActive(null);
      });
    };
    table.addEventListener("focusin", onFocusIn);
    table.addEventListener("focusout", onFocusOut);
    return () => {
      table.removeEventListener("focusin", onFocusIn);
      table.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  // ---- drag-reorder (rows and columns; grid startRowDrag idiom) -------------
  // Handle pointerdown → startPointerDrag: a released click (never crossed the
  // 4px threshold) opens the menu, a real drag reorders. During the drag the
  // pill follows the pointer along its axis, the source row/column wears an
  // accent outline, and a 2px accent line marks the drop boundary. Geometry is
  // re-queried from the DOM every move (no snapshot — page scroll can't stale
  // it). Overlays live in .doc-table-inner so they track horizontal scroll.
  type Drag = {
    kind: "row" | "col"; src: number; on: boolean; pos: number;
    outline: { left: number; top: number; width: number; height: number } | null;
    line: number | null;
  };
  const [drag, setDrag] = useState<Drag | null>(null);
  const startReorder = (e: PointerEvent, kind: "row" | "col", src: number) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault(); // keeps the cell focused (touch: also stops the scroll gesture; CSS touch-action:none backs this up)
    e.stopPropagation();
    const wrap = wrapRef.current, inner = innerRef.current, table = tableRef.current;
    if (!wrap || !inner || !table) return;
    const pos0 = kind === "row" ? (active?.rowTop ?? 0) : (active?.colX ?? 0);
    let bound: number | null = null;
    setDrag({ kind, src, on: false, pos: pos0, outline: null, line: null });
    startPointerDrag(e, {
      onStart: () => document.body.classList.add("table-dragging"),
      onMove: (ev) => {
        const wr = wrap.getBoundingClientRect();
        const ir = inner.getBoundingClientRect();
        const tb = table.getBoundingClientRect();
        const body = table.tBodies[0]!;
        let outline: Drag["outline"], pos: number, line: number | null = null;
        if (kind === "row") {
          const trs = Array.from(body.rows);
          const sr = trs[src]!.getBoundingClientRect();
          outline = { left: tb.left - ir.left, top: sr.top - ir.top, width: tb.width, height: sr.height };
          pos = Math.round(Math.min(Math.max(ev.clientY, trs[1]!.getBoundingClientRect().top), tb.bottom) - wr.top - 14);
          let t = rows.length;
          for (let i = 1; i < trs.length; i++) {
            const rr = trs[i]!.getBoundingClientRect();
            if (ev.clientY < rr.top + rr.height / 2) { t = i; break; }
          }
          bound = t === src || t === src + 1 ? null : t;
          if (bound != null) {
            const edge = bound === rows.length ? trs[trs.length - 1]!.getBoundingClientRect().bottom : trs[bound]!.getBoundingClientRect().top;
            line = Math.round(edge - ir.top);
          }
        } else {
          const tds = Array.from(body.rows[0]!.cells);
          const sc = tds[src]!.getBoundingClientRect();
          outline = { left: sc.left - ir.left, top: tb.top - ir.top, width: sc.width, height: tb.height };
          const lo = Math.max(tb.left, wr.left), hi = Math.min(tb.right, wr.right);
          pos = Math.round(Math.min(Math.max(ev.clientX, lo + 10), hi - 10) - wr.left);
          let t = cols;
          for (let i = 0; i < tds.length; i++) {
            const cr = tds[i]!.getBoundingClientRect();
            if (ev.clientX < cr.left + cr.width / 2) { t = i; break; }
          }
          bound = t === src || t === src + 1 ? null : t;
          if (bound != null) {
            const edge = bound === cols ? tds[tds.length - 1]!.getBoundingClientRect().right : tds[bound]!.getBoundingClientRect().left;
            line = Math.round(edge - ir.left);
          }
        }
        setDrag({ kind, src, on: true, pos, outline, line });
      },
      onEnd: (_ev, dragged) => {
        document.body.classList.remove("table-dragging");
        setDrag(null);
        if (!dragged) {
          openMenu(e, (close) => (kind === "row" ? rowMenuItems(src, close) : colMenuItems(src, close)));
          return;
        }
        if (bound != null) (kind === "row" ? moveRowTo : moveColTo)(src, bound);
      },
    });
  };

  const rowHandleTop = drag ? (drag.kind === "row" ? drag.pos : null) : active && active.r >= 1 ? active.rowTop : null;
  const colHandleLeft = drag ? (drag.kind === "col" ? drag.pos : null) : active && active.colOn ? active.colX : null;

  // Touch selection action bar — the OSK has no Delete/⌘C, so the rectangle
  // needs on-screen verbs. Lives on the wrap layer (no vertical clipping)
  // just above the selection, clamped into the scrollport; re-measured per
  // render (the onScroll tick below keeps it glued under horizontal scroll).
  const [, setScrollTick] = useState(0);
  const selBarPos = (): { left: number; top: number } | null => {
    if (!COARSE || !rect) return null;
    const wrap = wrapRef.current, body = tableRef.current?.tBodies[0];
    const a = body?.rows[rect.r0]?.cells[rect.c0], b = body?.rows[rect.r1]?.cells[rect.c1];
    if (!wrap || !a || !b) return null;
    const wr = wrap.getBoundingClientRect();
    const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
    return {
      left: Math.round(Math.min(Math.max((ar.left + br.right) / 2 - wr.left - 66, 4), wr.width - 136)),
      top: Math.round(Math.max(ar.top - wr.top - 38, -34)),
    };
  };
  const selBar = selBarPos();
  const copyFlash = () => {
    const tbl = tableRef.current;
    if (!tbl) return;
    tbl.classList.remove("copied");
    void tbl.offsetWidth;
    tbl.classList.add("copied");
    setTimeout(() => tbl.classList.remove("copied"), 260);
  };

  return (
    <div
      class="doc-table-wrap"
      ref={wrapRef}
      onMouseMove={trackCell}
      onMouseLeave={() => { if (!document.body.classList.contains("table-dragging")) setActive(null); }}
    >
      {rowHandleTop != null && (
        <button
          class={"doc-row-handle" + (drag?.kind === "row" ? " grab" : "")}
          style={{ top: rowHandleTop }}
          title="行选项"
          onPointerDown={(e) => { if (drag == null && active) startReorder(e as PointerEvent, "row", active.r); }}
        >
          <Icon name="grip" cls="ico sm" />
        </button>
      )}
      {colHandleLeft != null && (
        <button
          class={"doc-col-handle" + (drag?.kind === "col" ? " grab" : "")}
          style={{ left: colHandleLeft }}
          title="列选项"
          onPointerDown={(e) => { if (drag == null && active) startReorder(e as PointerEvent, "col", active.c); }}
        >
          <Icon name="gripH" cls="ico sm" />
        </button>
      )}
      {selBar && rect && (
        <div class="doc-sel-bar" style={{ left: selBar.left, top: selBar.top }}>
          <button onClick={() => { navigator.clipboard?.writeText(selectionToTsv(rows, rect)).catch(() => {}); copyFlash(); }}>复制</button>
          <button onClick={() => { block.rows = clearRect(rows, rect); onTableChange(); onCellSel(null); }}>清空</button>
          <button onClick={() => onCellSel(null)}>✕</button>
        </div>
      )}
      <div class="doc-table-scroll" onScroll={() => { setScrollTick((t) => t + 1); setActive((a) => (a ? measureActive(a.r, a.c) : a)); }}>
        <div class="doc-table-inner" ref={innerRef}>
          {drag?.on && drag.outline && (
            <>
              <div class="doc-drag-outline" style={{ left: drag.outline.left, top: drag.outline.top, width: drag.outline.width, height: drag.outline.height }} />
              {drag.line != null && (drag.kind === "row"
                ? <div class="doc-rowdrop" style={{ top: drag.line, left: drag.outline.left, width: drag.outline.width }} />
                : <div class="doc-coldrop" style={{ left: drag.line, top: drag.outline.top, height: drag.outline.height }} />)}
            </>
          )}
          <div class="doc-table-row">
            <table ref={tableRef} class={"doc-table" + (manual ? "" : " autofit") + (rect ? " cells-active" : "")}>
              <colgroup>
                {Array.from({ length: cols }, (_, c) => (
                  <col key={c} data-tcol={c} style={manual ? { width: widths.current[c] } : undefined} />
                ))}
              </colgroup>
              <tbody>
                {rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => {
                      const inSel = rect != null && inRect(rect, r, c);
                      const handle = rect != null && r === rect.r1 && c === rect.c1;
                      return (
                      <td
                        key={c}
                        class={(r === 0 ? "doc-th" : "") + (inSel ? " cellsel" : "")}
                        style={rect ? { boxShadow: edgeShadow(rect, r, c) } : undefined}
                        onPointerDown={(e) => startCellSelect(e as PointerEvent, r, c)}
                      >
                        <TableCell
                          value={cell}
                          renderKey={renderKey}
                          r={r}
                          c={c}
                          align={align[c] ?? null}
                          onInput={(v) => onCellInput(r, c, v)}
                          onKeyDown={(e) => onCellKeyDown(e, r, c)}
                        />
                        {handle && <div class="doc-cell-handle" onPointerDown={(e) => startHandleDrag(e as PointerEvent)} />}
                        {r === 0 && <div class="doc-col-resizer" onPointerDown={(e) => startResize(e as PointerEvent, c)} />}
                      </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <button class="doc-table-addcol" title="新增列" onMouseDown={(e) => { e.preventDefault(); addCol(); }}>
              <Icon name="plus" cls="ico sm" />
            </button>
          </div>
          <button class="doc-table-addrow" title="新增行" onMouseDown={(e) => { e.preventDefault(); addRow(); }}>
            <Icon name="plus" cls="ico sm" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function TableCell({
  value, renderKey, r, c, align, onInput, onKeyDown,
}: {
  value: string;
  renderKey: number;
  r: number;
  c: number;
  align: ColAlign;
  onInput: (value: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Uncontrolled: rewrite innerHTML only on a structural re-render (renderKey),
  // never on every keystroke — mirrors the .editable host so the caret survives.
  // Same semantic guard as the .editable effect: the live DOM may differ from
  // inlineToHtml's output yet mean the same markdown (&nbsp;, <b> vs <strong>).
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const html = inlineToHtml(value);
      if (el.innerHTML !== html && htmlToInline(el.innerHTML) !== value) el.innerHTML = html;
    }
  }, [renderKey]);
  return (
    <div
      ref={ref}
      class="doc-td"
      data-r={r}
      data-c={c}
      contentEditable
      data-ph={r === 0 ? "表头" : ""}
      style={align ? { textAlign: align } : undefined}
      onInput={(e) => onInput(htmlToInline((e.currentTarget as HTMLElement).innerHTML))}
      onKeyDown={(e) => onKeyDown(e as KeyboardEvent)}
    />
  );
}
