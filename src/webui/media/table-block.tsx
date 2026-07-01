/** @jsxImportSource preact */
// A GFM pipe table rendered as a real <table> of contentEditable cells. Cell
// edits are uncontrolled (innerHTML rewritten only on a structural re-render, via
// renderKey) so typing never resets the caret — same pattern as the .editable /
// CodeBlock hosts. Structural ops (add/del row & col, alignment) go through
// onTableChange → bump(). Column widths are session-only: kept in a ref and
// written straight onto the <col> elements, never serialized to Markdown.
import { useEffect, useRef } from "preact/hooks";
import type { Block, ColAlign } from "../blocks.ts";
import { Icon } from "../icons.tsx";
import { openMenu, MenuItem, MenuLabel, MenuSep } from "../ui.tsx";
import { inlineToHtml, htmlToInline } from "../markdown.tsx";
import { startColumnResize, startPointerDrag } from "../pointer-drag.ts";
import { type CellSel, normRect, inRect, edgeShadow } from "../cell-select.ts";

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
  // Keep the session-only width array sized to the column count; new columns
  // inherit the default, existing widths are preserved across re-renders.
  if (widths.current.length !== cols) {
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
  const setAlign = (c: number, a: ColAlign) => {
    const next = Array.from({ length: cols }, (_, i) => align[i] ?? null);
    next[c] = a;
    block.align = next;
    onTableChange();
  };

  // Move focus by (dr, dc) within this table; returns false if out of bounds.
  const focusCell = (r: number, c: number): boolean => {
    const el = tableRef.current?.querySelector<HTMLElement>(`.doc-td[data-r="${r}"][data-c="${c}"]`);
    if (!el) return false;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const s = getSelection();
    s?.removeAllRanges();
    s?.addRange(range);
    return true;
  };

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
    startColumnResize(e, {
      col: tableRef.current?.querySelector<HTMLElement>(`col[data-tcol="${c}"]`) ?? null,
      startWidth: widths.current[c] ?? 160,
      min: 60,
      onDone: (w) => { widths.current[c] = w; },
    });
  };

  const colMenu = (e: MouseEvent, c: number) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e, (close) => (
      <>
        <MenuLabel>对齐方式</MenuLabel>
        <MenuItem icon="alignLeft" label="左对齐" checked={(align[c] ?? null) === null || align[c] === "left"} onClick={() => { setAlign(c, "left"); close(); }} />
        <MenuItem icon="alignCenter" label="居中" checked={align[c] === "center"} onClick={() => { setAlign(c, "center"); close(); }} />
        <MenuItem icon="alignRight" label="右对齐" checked={align[c] === "right"} onClick={() => { setAlign(c, "right"); close(); }} />
        <MenuSep />
        <MenuItem icon="plus" label="在左侧插入列" onClick={() => { insertCol(c); close(); }} />
        <MenuItem icon="cornerUpRight" label="在右侧插入列" onClick={() => { insertCol(c + 1); close(); }} />
        <MenuItem icon="trash" label="删除列" danger onClick={() => { deleteCol(c); close(); }} />
      </>
    ));
  };

  return (
    <div class="doc-table-wrap">
      <div class="doc-table-scroll">
        <div class="doc-table-inner">
          <div class="doc-table-row">
            <table ref={tableRef} class={"doc-table" + (rect ? " cells-active" : "")}>
              <colgroup>
                {Array.from({ length: cols }, (_, c) => (
                  <col key={c} data-tcol={c} style={{ width: widths.current[c] }} />
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
                        {c === 0 && r > 0 && rows.length > 2 && (
                          <button class="doc-row-del" title="删除行" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); deleteRow(r); }}>
                            <Icon name="trash" cls="ico sm" />
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
