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
import { type CellSel, normRect, inRect, edgeShadow } from "../cell-select.ts";

// Touch (no hover): row/col ops live in the focused cell's ⋯ menu instead of
// hover affordances. Evaluated once — a device's pointer class doesn't change
// mid-session, and gating the render (not just CSS) keeps desktop DOM-free.
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
  const moveRow = (r: number, dir: -1 | 1) => {
    const to = r + dir;
    if (r < 1 || to < 1 || to >= rows.length) return; // header pinned
    const n = [...rows];
    const [row] = n.splice(r, 1);
    n.splice(to, 0, row!);
    block.rows = n;
    onTableChange();
  };
  const moveCol = (c: number, dir: -1 | 1) => {
    const to = c + dir;
    if (to < 0 || to >= cols) return;
    block.rows = rows.map((row) => { const n = [...row]; const [v] = n.splice(c, 1); n.splice(to, 0, v ?? ""); return n; });
    const a = Array.from({ length: cols }, (_, i) => align[i] ?? null);
    const [av] = a.splice(c, 1);
    a.splice(to, 0, av ?? null);
    block.align = a;
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
    // Touch drags scroll (or long-press selects text) natively; box-select is
    // mouse-only — the OSK has no Delete/⌘C to drive a rectangle anyway.
    if (e.pointerType === "touch") return;
    if (e.button !== 0) return;
    // Let the column menu / resizer / row-delete buttons handle their own clicks.
    if ((e.target as HTMLElement).closest("button,a,.doc-col-resizer")) return;
    const dropEdit = () => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      getSelection()?.removeAllRanges();
    };
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

  // Shared menu fragments: the th chevron (desktop), the gutter row handle
  // (desktop) and the focused cell's ⋯ (touch) all compose from these. r/c are
  // captured when the menu opens, so later focus/hover changes can't retarget
  // an open menu. Items that would be silent no-ops simply don't render.
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
      {cols > 1 && <MenuItem icon="trash" label="删除列" danger onClick={() => { deleteCol(c); close(); }} />}
    </>
  );
  const rowMenuItems = (r: number, close: () => void) => (
    <>
      {r >= 1 && <MenuItem icon="plus" label="在上方插入行" onClick={() => { insertRow(r); close(); }} />}
      <MenuItem icon="cornerUpRight" label="在下方插入行" onClick={() => { insertRow(r + 1); close(); }} />
      {r > 0 && <MenuItem icon="copy" label="复制行" onClick={() => { duplicateRow(r); close(); }} />}
      {r > 0 && rows.length > 2 && <MenuItem icon="trash" label="删除行" danger onClick={() => { deleteRow(r); close(); }} />}
    </>
  );
  // Touch has no drag-reorder (and never will get the desktop hover drags), so
  // the aggregated menu is the only way to rearrange — desktop menus skip these.
  const moveMenuItems = (r: number, c: number, close: () => void) => (
    <>
      {r > 1 && <MenuItem icon="arrowUp" label="上移行" onClick={() => { moveRow(r, -1); close(); }} />}
      {r >= 1 && r < rows.length - 1 && <MenuItem icon="chevronDown" label="下移行" onClick={() => { moveRow(r, 1); close(); }} />}
      {c > 0 && <MenuItem icon="arrowLeft" label="左移列" onClick={() => { moveCol(c, -1); close(); }} />}
      {c < cols - 1 && <MenuItem icon="chevron" label="右移列" onClick={() => { moveCol(c, 1); close(); }} />}
    </>
  );

  const colMenu = (e: MouseEvent, c: number) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e, (close) => colMenuItems(c, close));
  };

  // Touch: the focused cell's ⋯ aggregates column + row + reorder ops (hover
  // affordances are unreachable). Deliberately NO preventDefault — the cell
  // must blur so the iOS keyboard collapses before the fixed-bottom action
  // sheet (.pop.sheet) opens, or the sheet would sit behind the OSK. This is
  // the opposite of colMenu's preventDefault, which keeps desktop cell focus.
  const cellMenu = (e: PointerEvent, r: number, c: number) => {
    e.stopPropagation();
    openMenu(e, (close) => (
      <>
        {colMenuItems(c, close)}
        <MenuSep />
        {rowMenuItems(r, close)}
        <MenuSep />
        {moveMenuItems(r, c, close)}
      </>
    ));
  };

  // Desktop row handle: a single floating grip in the left gutter tracks the
  // hovered row (same idiom as the grid's rowgrip-ext / trackGripAt). It lives
  // on .doc-table-wrap OUTSIDE .doc-table-scroll so overflow-x can't clip it,
  // and off the cell text entirely (the old .doc-row-del sat on top of the
  // first cell's text). Data rows only: the block gutter's +/grip pins at the
  // table's top edge — the header row's y — so r ≥ 1 also avoids that overlap.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [grip, setGrip] = useState<{ r: number; top: number } | null>(null);
  useEffect(() => setGrip(null), [renderKey]); // row heights may have changed
  const trackRow = (e: MouseEvent) => {
    const wrap = wrapRef.current;
    const tr = (e.target as HTMLElement).closest?.("tr");
    if (!wrap || !tr || !wrap.contains(tr)) return;
    const td = tr.querySelector<HTMLElement>(".doc-td");
    const r = td ? Number(td.dataset.r) : NaN;
    if (!Number.isFinite(r) || r < 1) { setGrip(null); return; }
    const top = Math.round(tr.getBoundingClientRect().top - wrap.getBoundingClientRect().top) + 5;
    setGrip((g) => (g && g.r === r && g.top === top ? g : { r, top }));
  };

  return (
    <div class="doc-table-wrap" ref={wrapRef} onMouseMove={trackRow} onMouseLeave={() => setGrip(null)}>
      {grip && (
        <button
          class="doc-row-handle"
          style={{ top: grip.top }}
          title="行选项"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openMenu(e as MouseEvent, (close) => rowMenuItems(grip.r, close));
          }}
        >
          <Icon name="grip" cls="ico sm" />
        </button>
      )}
      <div class="doc-table-scroll">
        <div class="doc-table-inner">
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
                        {r === 0 && (
                          <>
                            <button class="doc-col-menu" title="列选项" onMouseDown={(e) => colMenu(e as MouseEvent, c)}>
                              <Icon name="chevronDown" cls="ico sm" />
                            </button>
                            <div class="doc-col-resizer" onPointerDown={(e) => startResize(e as PointerEvent, c)} />
                          </>
                        )}
                        {COARSE && (
                          <button class="doc-cell-menu" title="单元格选项" onPointerDown={(e) => cellMenu(e as PointerEvent, r, c)}>
                            <Icon name="dots" cls="ico sm" />
                          </button>
                        )}
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
