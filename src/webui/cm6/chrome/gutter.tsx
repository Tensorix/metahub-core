/** @jsxImportSource preact */
// Left hover gutter: a "+" (insert an empty line below the block) and a grip
// (drag to reorder the block, click for a menu). Renders a small overlay pinned to
// the left of the hovered block's first line. A "block" is a single line, the
// whole line-span of a void, or a quote's whole contiguous run (blockAt) — so
// hover/drag/duplicate/delete/convert all act on the same unit Tab steps.
// Reorder moves that line span with one text transaction (native undo covers
// it). All coord reads go through the deferred path.

import { render } from "preact";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { PluginValue, ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { Icon } from "../../icons.tsx";
import { openMenu, MenuItem, MenuLabel, MenuSep } from "../../ui.tsx";
import { BLOCK_MENU } from "../../blocks.ts";
import { docModel } from "../doc-model";
import { deferCoords } from "../defer";
import { blockAt, blockSpanWithChildren, rangeForSelection, lineSpanRange, duplicateRange, type BlockRange as Range } from "../block-range";
import { turnInto, type TargetType } from "../convert";

// "转换为" targets, in menu order; labels/icons come from the shared BLOCK_MENU
// (same strings/icons as the slash menu and the old editor's grip menu).
const CONVERT_TYPES: TargetType[] = ["p", "h1", "h2", "h3", "quote", "bullet", "numbered", "todo", "code"];
const CONVERT_ITEMS = CONVERT_TYPES.map((t) => {
  const m = BLOCK_MENU.find((m) => m.type === t)!;
  return { type: t, ic: m.ic, t: m.t };
});

/** The block's current type as a convert target (for the menu checkmark). */
function currentType(view: EditorView, line: number): TargetType | null {
  const model = docModel(view.state);
  const info = model.lines[line - 1];
  if (!info) return null;
  if (info.role === "void") {
    const v = model.voids.find((v) => line >= v.fromLine && line <= v.toLine);
    return v && (v.kind === "code" || v.kind === "html") ? "code" : null;
  }
  return (CONVERT_TYPES as string[]).includes(info.role) ? (info.role as TargetType) : null;
}

class GutterPlugin implements PluginValue {
  private host: HTMLElement;
  private surface: HTMLElement; // hover surface — the whole .doc, so the left margin counts
  private line = 0; // hovered 1-based line, 0 = hidden
  private raf = 0;
  private dropLine: HTMLElement | null = null; // reorder drop indicator

  constructor(readonly view: EditorView) {
    this.host = document.createElement("div");
    this.host.className = "cm-gutter-layer";
    this.host.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:20";
    view.dom.style.position ||= "relative";
    view.dom.appendChild(this.host);
    // Track hover on the whole document container (incl. the left gutter margin),
    // not just the text scroller — otherwise moving toward the -52px buttons exits
    // the scroller and the handle vanishes before it can be clicked.
    this.surface = (view.dom.closest(".doc") as HTMLElement | null) ?? view.dom;
    this.surface.addEventListener("mousemove", this.onMove);
    this.surface.addEventListener("mouseleave", this.onLeave);
  }

  update(u: ViewUpdate) {
    if (u.docChanged || u.geometryChanged || u.viewportChanged) this.schedule();
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.surface.removeEventListener("mousemove", this.onMove);
    this.surface.removeEventListener("mouseleave", this.onLeave);
    render(null, this.host);
    this.host.remove();
    this.dropLine?.remove();
  }

  private onLeave = () => { if (this.line) { this.line = 0; this.schedule(); } };

  // Resolve the hovered line by the mouse Y with X clamped INTO the content box, so
  // the handle stays locked to a line while the pointer is out in the left margin
  // (over the +/grip buttons) — that's the whole point of a hover gutter.
  private onMove = (e: MouseEvent) => {
    const c = this.view.contentDOM.getBoundingClientRect();
    if (e.clientY < c.top - 4 || e.clientY > c.bottom + 4) {
      if (this.line) { this.line = 0; this.schedule(); }
      return;
    }
    const x = Math.min(Math.max(e.clientX, c.left + 1), c.right - 1);
    const pos = this.view.posAtCoords({ x, y: e.clientY });
    const n = pos == null ? 0 : this.view.state.doc.lineAt(pos).number;
    if (n !== this.line) { this.line = n; this.schedule(); }
  };

  private schedule() {
    if (this.raf) return;
    this.raf = deferCoords(() => { this.raf = 0; this.paint(); });
  }

  private insertBelow(range: Range) {
    this.view.dispatch({ changes: { from: range.to, insert: "\n" }, selection: { anchor: range.to + 1 }, scrollIntoView: true });
    this.view.focus();
  }

  private remove(range: Range) {
    const docLen = this.view.state.doc.length;
    const to = range.to < docLen ? range.to + 1 : range.to; // include trailing newline
    const from = range.to >= docLen && range.from > 0 ? range.from - 1 : range.from;
    this.view.dispatch({ changes: { from, to, insert: "" } });
  }

  private menu(e: MouseEvent, range: Range) {
    const view = this.view;
    const model = docModel(view.state);
    // Multi-line mode: the main selection is non-empty AND covers the gripped
    // block → the menu acts on the selection's whole line range (snapped to
    // void boundaries), like the old editor's block-group menu.
    const sel = rangeForSelection(view);
    const multi = !!sel && sel.fromLine <= range.fromLine && sel.toLine >= range.toLine && sel.toLine > sel.fromLine;
    const target = multi ? lineSpanRange(view, sel!.fromLine, sel!.toLine) : range;
    const count = target.toLine - target.fromLine + 1;
    // 复制/删除 act on the block's whole subtree (a parent list item carries its
    // indented children — the old block-tree semantics); 转换为 stays on the
    // block itself — a single line, or a quote's whole run (blockAt), where a
    // whole-run conversion is the block semantics — converting children along
    // with a parent list item would be wrong.
    const moveTarget = multi ? target : blockSpanWithChildren(view, range.fromLine);
    // A media/table void has no text to convert (lossy) → hide "转换为" for it.
    // A fenced code/html void can still unwrap to prose → offer just 正文.
    const v = model.voids.find((v) => range.fromLine >= v.fromLine && range.fromLine <= v.toLine);
    const textVoid = !!v && (v.kind === "code" || v.kind === "html");
    const showConvert = multi || !v || textVoid;
    const items = !multi && textVoid ? CONVERT_ITEMS.filter((m) => m.type === "p") : CONVERT_ITEMS;
    const current = multi ? null : currentType(view, range.fromLine);
    openMenu(e, (close) => (
      <>
        {showConvert && (
          <>
            <MenuLabel>{multi ? `转换为（${count} 行）` : "转换为"}</MenuLabel>
            {items.map((m) => (
              <MenuItem
                key={m.type}
                icon={m.ic}
                label={m.t}
                checked={current === m.type}
                onClick={() => { turnInto(view, target.fromLine, target.toLine, m.type); close(); }}
              />
            ))}
            <MenuSep />
          </>
        )}
        <MenuItem icon="copy" label={multi ? "复制块组" : "复制块"} onClick={() => { duplicateRange(view, moveTarget); close(); }} />
        <MenuItem icon="trash" label={multi ? "删除块组" : "删除块"} danger onClick={() => { this.remove(moveTarget); close(); }} />
      </>
    ));
  }

  /** A 2px accent line marking where a dragged block will drop, at viewport-y `y`. */
  private showDrop(y: number) {
    if (!this.dropLine) {
      const d = document.createElement("div");
      d.className = "cm-drop-line";
      d.style.cssText =
        "position:absolute;height:2px;background:var(--accent);border-radius:1px;pointer-events:none;z-index:25";
      this.view.dom.appendChild(d);
      this.dropLine = d;
    }
    const box = this.view.dom.getBoundingClientRect();
    const content = this.view.contentDOM.getBoundingClientRect();
    this.dropLine.style.left = `${content.left - box.left}px`;
    this.dropLine.style.width = `${content.width}px`;
    this.dropLine.style.top = `${y - box.top - 1}px`;
    this.dropLine.style.display = "";
  }
  private hideDrop() {
    if (this.dropLine) this.dropLine.style.display = "none";
  }

  // Pointer-drag reorder: move the source block before/after the block under the
  // pointer (by pointer-Y vs that block's midpoint), with a live drop indicator.
  // Invariant: `target` is non-zero exactly while the indicator is visible, so a
  // release with no indicator (dragged back over the source, or off-content) is a
  // no-op instead of replaying the last valid hover position.
  private startDrag(e: PointerEvent, src: Range) {
    e.preventDefault();
    let target = 0;
    let before = false;
    const clear = () => { target = 0; this.hideDrop(); };
    const move = (ev: PointerEvent) => {
      const pos = this.view.posAtCoords({ x: ev.clientX, y: ev.clientY });
      if (pos == null) return clear();
      const line = this.view.state.doc.lineAt(pos).number;
      if (line >= src.fromLine && line <= src.toLine) return clear(); // over itself
      const b = blockAt(this.view, line);
      const top = this.view.coordsAtPos(b.from);
      const bot = this.view.coordsAtPos(b.to);
      if (!top || !bot) return clear();
      before = ev.clientY < (top.top + bot.bottom) / 2;
      target = line;
      this.showDrop(before ? top.top : bot.bottom);
    };
    const finish = (drop: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      const t = target;
      const b = before;
      clear();
      // Re-validate against the current doc: a remote merge during the drag can
      // shorten the document under us.
      if (drop && t && t <= this.view.state.doc.lines) this.reorder(src, t, b);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  private reorder(src: Range, targetLine: number, before: boolean) {
    const doc = this.view.state.doc;
    const block = this.view.state.sliceDoc(src.from, src.to);
    const target = blockAt(this.view, targetLine);
    const changes: { from: number; to: number; insert: string }[] = [];
    const srcTo = src.to < doc.length ? src.to + 1 : src.to;
    const srcFrom = src.to >= doc.length && src.from > 0 ? src.from - 1 : src.from;
    changes.push({ from: srcFrom, to: srcTo, insert: "" });
    const insertAt = before ? target.from : target.to;
    changes.push({ from: insertAt, to: insertAt, insert: before ? block + "\n" : "\n" + block });
    this.view.dispatch({ changes, userEvent: "move.reorder" });
  }

  private paint() {
    if (!this.line || this.line > this.view.state.doc.lines) return this.hide();
    const range = blockAt(this.view, this.line);
    const coords = this.view.coordsAtPos(range.from);
    if (!coords) return this.hide();
    const box = this.view.dom.getBoundingClientRect();
    const top = coords.top - box.top;
    render(
      <div class="cm-block-gutter" style={{ position: "absolute", left: "-52px", top: `${top}px`, display: "flex", gap: "2px", pointerEvents: "auto" }}>
        <button class="cm-g-btn" title="在下方插入" onMouseDown={(e) => { e.preventDefault(); this.insertBelow(range); }}>
          <Icon name="plus" cls="ico sm" />
        </button>
        <button
          class="cm-g-btn cm-g-grip"
          title="拖动重排 / 点击菜单"
          // Drag moves the whole subtree (children travel with a parent item).
          onPointerDown={(e) => this.startDrag(e as PointerEvent, blockSpanWithChildren(this.view, this.line))}
          onClick={(e) => this.menu(e as MouseEvent, range)}
        >
          <Icon name="grip" cls="ico sm" />
        </button>
      </div>,
      this.host,
    );
  }

  private hide() { render(null, this.host); }
}

export function blockGutter(): Extension {
  return ViewPlugin.fromClass(GutterPlugin);
}
