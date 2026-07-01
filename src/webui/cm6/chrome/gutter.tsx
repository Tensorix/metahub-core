/** @jsxImportSource preact */
// Left hover gutter: a "+" (insert an empty line below the block) and a grip
// (drag to reorder the block, click for a menu). Renders a small overlay pinned to
// the left of the hovered block's first line. A "block" is a single line, or the
// whole line-span of a void. Reorder moves that line span with one text transaction
// (native undo covers it). All coord reads go through the deferred path.

import { render } from "preact";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { PluginValue, ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { Icon } from "../../icons.tsx";
import { openMenu, MenuItem } from "../../ui.tsx";
import { docModel } from "../doc-model";

interface Range { fromLine: number; toLine: number; from: number; to: number; }

/** The line span of the block at 1-based line `n` (a void spans multiple lines). */
function blockAt(view: EditorView, n: number): Range {
  const v = docModel(view.state).voids.find((v) => n >= v.fromLine && n <= v.toLine);
  const doc = view.state.doc;
  if (v) return { fromLine: v.fromLine, toLine: v.toLine, from: doc.line(v.fromLine).from, to: doc.line(v.toLine).to };
  const line = doc.line(n);
  return { fromLine: n, toLine: n, from: line.from, to: line.to };
}

class GutterPlugin implements PluginValue {
  private host: HTMLElement;
  private surface: HTMLElement; // hover surface — the whole .doc, so the left margin counts
  private line = 0; // hovered 1-based line, 0 = hidden
  private raf = 0;

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
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
  }

  private insertBelow(range: Range) {
    this.view.dispatch({ changes: { from: range.to, insert: "\n" }, selection: { anchor: range.to + 1 }, scrollIntoView: true });
    this.view.focus();
  }

  private duplicate(range: Range) {
    const text = this.view.state.sliceDoc(range.from, range.to);
    this.view.dispatch({ changes: { from: range.to, insert: "\n" + text } });
  }

  private remove(range: Range) {
    const docLen = this.view.state.doc.length;
    const to = range.to < docLen ? range.to + 1 : range.to; // include trailing newline
    const from = range.to >= docLen && range.from > 0 ? range.from - 1 : range.from;
    this.view.dispatch({ changes: { from, to, insert: "" } });
  }

  private menu(e: MouseEvent, range: Range) {
    openMenu(e, (close) => (
      <>
        <MenuItem icon="copy" label="复制块" onClick={() => { this.duplicate(range); close(); }} />
        <MenuItem icon="trash" label="删除块" danger onClick={() => { this.remove(range); close(); }} />
      </>
    ));
  }

  // Pointer-drag reorder: move the source block's lines to before/after the block
  // under the pointer at drop time.
  private startDrag(e: PointerEvent, src: Range) {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const pos = this.view.posAtCoords({ x: ev.clientX, y: ev.clientY });
      if (pos != null) this.host.dataset.drop = String(this.view.state.doc.lineAt(pos).number);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const pos = this.view.posAtCoords({ x: ev.clientX, y: ev.clientY });
      delete this.host.dataset.drop;
      if (pos == null) return;
      const targetLine = this.view.state.doc.lineAt(pos).number;
      if (targetLine >= src.fromLine && targetLine <= src.toLine) return; // dropped on itself
      this.reorder(src, targetLine);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private reorder(src: Range, targetLine: number) {
    const doc = this.view.state.doc;
    const block = this.view.state.sliceDoc(src.from, src.to);
    const target = blockAt(this.view, targetLine);
    // Delete the source (with its trailing newline), then insert before/after target.
    const after = targetLine > src.toLine; // moving down → insert after target block
    const changes = [] as { from: number; to: number; insert: string }[];
    const srcTo = src.to < doc.length ? src.to + 1 : src.to;
    const srcFrom = src.to >= doc.length && src.from > 0 ? src.from - 1 : src.from;
    changes.push({ from: srcFrom, to: srcTo, insert: "" });
    const insertAt = after ? target.to : target.from;
    changes.push({ from: insertAt, to: insertAt, insert: after ? "\n" + block : block + "\n" });
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
          onPointerDown={(e) => this.startDrag(e as PointerEvent, range)}
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
