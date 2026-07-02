/** @jsxImportSource preact */
// Void block widgets for the single-document editor.
//
// A StateField turns each void source range (fenced code/html, GFM table,
// single-line media — see blockmodel.ts) into a block-level `Decoration.replace`
// widget hosting the existing Preact component, and registers the atomic ones with
// `EditorView.atomicRanges`. Block replace decorations MUST come from a StateField
// (CM6 forbids them from a ViewPlugin), so this is a field, not a plugin.
//
// Two interaction models:
//   • ATOMIC (media, table, code): the caret can never land inside; the widget is
//     always present. Media "selected" = the CM selection spans the whole range
//     (resize handles show). Tables edit in place inside a contenteditable island;
//     code edits in place inside the CodeIsland's textarea (never degrades to raw
//     source — the island shows highlighted code plus ``` fence rows on focus).
//   • REVEAL-TO-EDIT (html only): NOT atomic. When the selection touches the range
//     the widget is dropped and the raw Markdown source shows for editing; the
//     源码 button dispatches a selection into it to trigger the reveal.
//
// Write-back: when a hosted component mutates its block (image resize, code lang,
// table cell), it re-serializes via blockToText and dispatches ONE change over the
// void's CURRENT range (located with posAtDOM), synchronously — the document is
// the single source of truth, there is no debounced shadow state. The widget's
// eq() returns true while its DOM holds focus, so that self-authored change never
// tears down the caret/IME — but ONLY for same-generation widgets: any doc change
// that is not our own `input.writeback` and intersects the void (remote merge,
// undo/redo) bumps its generation, forcing a rebuild from document truth. That is
// what keeps a focused island from silently overwriting a remote edit.

import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { StateField, RangeSetBuilder, Facet, type EditorState, type RangeSet } from "@codemirror/state";
import { undo, redo } from "@codemirror/commands";
import { docModel } from "../doc-model";
import { voidAt, type VoidKind, type VoidRange } from "../blockmodel";
import { blockToText, leadingIndent, stripIndent, type Block } from "../../blocks";
import { ImageBlock, VideoBlock, AudioBlock, FileBlock } from "../../media/media-blocks";
import { CodeIsland } from "../../media/code-block";
import { TableBlock, focusCellEnd } from "../../media/table-block";
import { type CellSel, normRect, moveCellSel, clearRect, selectionToTsv } from "../../cell-select";

const ATOMIC = new Set<VoidKind>(["image", "video", "audio", "file", "table", "code"]);
/** Media kinds where a plain click selects the whole void (resize handles etc.). */
const MEDIA = new Set<VoidKind>(["image", "video", "audio", "file"]);
const atomicMark = Decoration.mark({});

/** Host-app callbacks the void widgets need but that live outside the editor
 *  (e.g. the image preview: desktop native window / in-page lightbox is owned
 *  by DocView). Provided once by CmDocBody via `voidDeps.of(...)`. */
export interface VoidDeps {
  onPreviewImage?: (block: Block) => void;
}
export const voidDeps = Facet.define<VoidDeps, VoidDeps>({ combine: (v) => v[0] ?? {} });

const REPORTER = `<script>(function(){function r(){try{parent.postMessage({__mhHtmlHeight:document.documentElement.scrollHeight},'*')}catch(e){}}try{new ResizeObserver(r).observe(document.documentElement)}catch(e){}addEventListener('load',r);setTimeout(r,60);setTimeout(r,400)})();<\/script>`;
function htmlSrcdoc(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>html,body{margin:0;padding:0;color-scheme:light dark;font-family:system-ui,-apple-system,sans-serif}</style></head><body>${html}${REPORTER}</body></html>`;
}

/** Resolve the void currently under `host` (positions shift as the user types, so
 *  this must run fresh at commit/keystroke time, never be cached). */
function voidUnder(view: EditorView, host: HTMLElement): VoidRange | null {
  if (!host.isConnected) return null; // detached widget: posAtDOM would hit the wrong void
  const from = view.posAtDOM(host);
  const model = docModel(view.state);
  return voidAt(model, from) ?? voidAt(model, from + 1);
}

/** Leading whitespace of the void's opening line — the nesting indent that
 *  blockToText (which serializes at indent 0) must be re-applied with. */
function voidIndent(view: EditorView, v: VoidRange): string {
  return /^[ \t]*/.exec(view.state.doc.lineAt(v.from).text)![0]!;
}

/** Locate the void currently under `host` and replace its whole source range with
 *  the re-serialized block, unless the text is already identical. blockToText
 *  serializes flush-left, so for a NESTED void (opening line indented under a list
 *  item) every serialized line is re-prefixed with that indent — otherwise a cell
 *  edit / code keystroke would silently unindent the block out of its parent. */
function commit(view: EditorView, host: HTMLElement, block: Block) {
  const v = voidUnder(view, host);
  if (!v) return;
  let md = blockToText(block);
  const ws = voidIndent(view, v);
  if (ws) md = md.split("\n").map((l) => ws + l).join("\n");
  if (md === view.state.sliceDoc(v.from, v.to)) return;
  view.dispatch({ changes: { from: v.from, to: v.to, insert: md }, userEvent: "input.writeback" });
}

/** Focus the code island hosting void `v` and put the textarea caret at its start
 *  or end. Used by structure keys (arrow into the block, fence autocomplete). */
export function focusCodeVoid(view: EditorView, v: VoidRange, where: "start" | "end") {
  for (const host of Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-void-code"))) {
    const pos = view.posAtDOM(host);
    if (pos < v.from || pos > v.to) continue;
    const ta = host.querySelector<HTMLTextAreaElement>("textarea.code-input");
    if (!ta) return;
    ta.focus();
    const at = where === "start" ? 0 : ta.value.length;
    ta.setSelectionRange(at, at);
    ta.scrollIntoView({ block: "nearest" });
    return;
  }
}

/** Move the caret into the void's content (line after the opening fence) to trigger
 *  reveal-to-edit for html. */
function reveal(view: EditorView, host: HTMLElement) {
  const v = voidUnder(view, host);
  if (!v) return;
  const open = view.state.doc.lineAt(v.from);
  const anchor = Math.min(open.to + 1, v.to);
  view.dispatch({ selection: { anchor }, scrollIntoView: true });
  view.focus();
}

// ---- in-place editable table host ----
// bRef mirrors the void's block, but the document stays the single source of
// truth: every cell edit commits synchronously (commit() no-ops on identical
// text). The mirror is only valid because any EXTERNAL change to the void bumps
// the widget generation and rebuilds this component from the fresh doc — see
// VoidWidget.eq()/gens below.
function TableHost({ view, host, initial }: { view: EditorView; host: HTMLElement; initial: Block }) {
  const bRef = useRef<Block>(structuredClone(initial));
  const [cellSel, setCellSel] = useState<CellSel | null>(null);
  const [rk, setRk] = useState(0);

  // Cell-rectangle keyboard layer: arrows move/extend the rect, Cmd/Ctrl+C
  // copies it as TSV, Delete/Backspace clears it, Escape dismisses, Enter/F2
  // drops the caret into a single-cell rect. Document-level (bubble phase) —
  // the rectangle only exists while no editable holds focus, so anything typed
  // inside a cell/input is left alone by the guards at the top.
  useEffect(() => {
    if (!cellSel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return; // IME: keys confirm the candidate, not the rect
      const ae = document.activeElement as HTMLElement | null;
      if (ae?.isContentEditable || ae?.tagName === "INPUT" || ae?.tagName === "TEXTAREA") return;
      const rows = bRef.current.rows ?? [];
      const nrows = rows.length, ncols = rows[0]?.length ?? 0;
      if (!nrows || !ncols) return;
      const moved = moveCellSel(cellSel, e.key, e.shiftKey, nrows, ncols);
      if (moved) {
        e.preventDefault();
        setCellSel(moved);
        host.querySelector(`.doc-td[data-r="${moved.b.r}"][data-c="${moved.b.c}"]`)
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        navigator.clipboard?.writeText(selectionToTsv(rows, normRect(cellSel))).catch(() => {});
        // Brief accent flash: restart the animation by toggling the class across a reflow.
        const tbl = host.querySelector<HTMLElement>("table.doc-table");
        if (tbl) {
          tbl.classList.remove("copied");
          void tbl.offsetWidth;
          tbl.classList.add("copied");
          setTimeout(() => tbl.classList.remove("copied"), 260);
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        bRef.current.rows = clearRect(rows, normRect(cellSel));
        setRk((k) => k + 1);
        commit(view, host, bRef.current); // one synchronous transaction = one undo step
      } else if (e.key === "Escape") {
        setCellSel(null);
      } else if (
        (e.key === "Enter" || e.key === "F2") &&
        cellSel.a.r === cellSel.b.r && cellSel.a.c === cellSel.b.c
      ) {
        e.preventDefault();
        const { r, c } = cellSel.b;
        setCellSel(null);
        requestAnimationFrame(() => focusCellEnd(host, r, c));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cellSel]);

  // Dismiss the rectangle when the pointer goes down outside this table's host
  // (capture phase, so it clears before another table's own handler starts a
  // fresh selection on bubble).
  useEffect(() => {
    if (!cellSel) return;
    const onDown = (e: PointerEvent) => {
      if (!host.contains(e.target as Node | null)) setCellSel(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [cellSel]);

  return (
    <TableBlock
      block={bRef.current}
      renderKey={rk}
      cellSel={cellSel}
      onCellSel={setCellSel}
      onCellInput={(r, c, v) => {
        const rows = bRef.current.rows ?? [];
        if (rows[r]) rows[r]![c] = v;
        commit(view, host, bRef.current);
      }}
      onTableChange={() => {
        setRk((k) => k + 1);
        commit(view, host, bRef.current);
      }}
    />
  );
}

// ---- in-place editable code island host ----
// Same mirror-and-commit contract as TableHost: bRef holds the block, every
// keystroke commits synchronously (self write-back keeps the focused DOM via
// eq(); external changes bump the generation and rebuild from doc truth).
// The block's content is DEDENTED here (scanDoc's textToBlock keeps nested
// blocks' per-line indent) and commit() re-prefixes the void's indent, so the
// island always edits flush-left code regardless of nesting depth.

/** Strip `ws`'s column width from every line of `content`. */
function dedent(content: string, ws: string): string {
  if (!ws) return content;
  const cols = leadingIndent(ws);
  return content.split("\n").map((l) => stripIndent(l, cols)).join("\n");
}

function CodeHost({
  view, host, initial, source, selected,
}: {
  view: EditorView;
  host: HTMLElement;
  initial: Block;
  source: string;
  selected: boolean;
}) {
  const bRef = useRef<Block | null>(null);
  if (!bRef.current) {
    const b = structuredClone(initial);
    b.content = dedent(b.content, /^[ \t]*/.exec(source)![0]!);
    bRef.current = b;
  }
  const b = bRef.current;
  const composing = useRef(false);
  const [lang, setLang] = useState(b.lang ?? "");

  const doCommit = () => commit(view, host, bRef.current!);

  // Textarea keydown: structural keys the island owns. Enter is deliberately
  // absent — inside a code block Enter ONLY inserts a newline, never exits;
  // exit is ArrowDown on the last line or Backspace on an empty block.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    const ta = e.currentTarget as HTMLTextAreaElement;
    const mod = e.metaKey || e.ctrlKey;

    // Undo/redo route to CM history (commits are synchronous, so the doc always
    // holds the latest text). The undo is an external change for this island —
    // its generation bumps and it rebuilds from doc truth; re-focus the rebuilt
    // island (or the view, if the void was undone away).
    if (mod && (e.key === "z" || e.key === "Z" || e.key === "y")) {
      e.preventDefault();
      const isRedo = e.key === "y" || e.shiftKey;
      const anchor = voidUnder(view, host)?.from ?? 0;
      (isRedo ? redo : undo)(view);
      // The view's DOM updates synchronously in dispatch, so refocus right away
      // (an rAF gap would drop the next rapid Cmd+Z on the floor); the rAF pass
      // is a safety net in case the widget materialized late.
      const refocus = () => {
        const pos = Math.min(anchor, view.state.doc.length);
        const v = voidAt(docModel(view.state), pos);
        if (v && v.kind === "code") focusCodeVoid(view, v, "end");
        else view.focus();
      };
      refocus();
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) refocus();
      });
      return;
    }
    if (mod) return; // copy/paste/select-all etc.: textarea defaults

    if (e.key === "Tab") {
      e.preventDefault();
      ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true })); // repaint + commit
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      const v = voidUnder(view, host);
      if (!v) return;
      view.focus();
      view.dispatch({ selection: { anchor: v.from, head: v.to }, scrollIntoView: true });
      return;
    }
    if (e.key === "Backspace" && ta.value === "") {
      e.preventDefault();
      const v = voidUnder(view, host);
      if (!v) return;
      view.focus();
      view.dispatch({
        changes: { from: v.from, to: Math.min(v.to + 1, view.state.doc.length) },
        selection: { anchor: v.from },
        userEvent: "delete",
        scrollIntoView: true,
      });
      return;
    }
    const collapsed = ta.selectionStart === ta.selectionEnd;
    if (e.key === "ArrowDown" && collapsed && !ta.value.slice(ta.selectionEnd).includes("\n")) {
      // Last line → exit to the line below the void (create one at doc end).
      e.preventDefault();
      const v = voidUnder(view, host);
      if (!v) return;
      if (v.to >= view.state.doc.length)
        view.dispatch({ changes: { from: v.to, insert: "\n" }, userEvent: "input" });
      view.focus();
      view.dispatch({
        selection: { anchor: Math.min(v.to + 1, view.state.doc.length) },
        scrollIntoView: true,
      });
      return;
    }
    if (e.key === "ArrowUp" && collapsed && !ta.value.slice(0, ta.selectionStart).includes("\n")) {
      // First line → exit to the line above the void (create one at doc start).
      e.preventDefault();
      const v = voidUnder(view, host);
      if (!v) return;
      if (v.from === 0) {
        // Void at doc start: make a blank line above and land on it.
        view.dispatch({ changes: { from: 0, insert: "\n" }, userEvent: "input" });
        view.focus();
        view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
      } else {
        view.focus();
        view.dispatch({ selection: { anchor: v.from - 1 }, scrollIntoView: true });
      }
      return;
    }
  };

  return (
    <CodeIsland
      code={b.content}
      lang={lang}
      selected={selected}
      onInput={(v) => {
        bRef.current!.content = v;
        if (!composing.current) doCommit(); // IME: commit once on compositionend
      }}
      onLang={(l) => {
        bRef.current!.lang = l;
        setLang(l);
        doCommit();
      }}
      onKeyDown={onKeyDown}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={(v) => {
        composing.current = false;
        bRef.current!.content = v;
        doCommit();
      }}
    />
  );
}

/** Iframe height reporter for html voids. A function component so the window
 *  "message" listener is added/removed by the effect lifecycle — the old inline
 *  ref-callback version leaked one listener (pinning the iframe + view) per
 *  widget rebuild. */
function HtmlFrame({ html, view }: { html: string; view: EditorView }) {
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const el = ref.current;
      if (!el || e.source !== el.contentWindow) return;
      const h = Number((e.data as { __mhHtmlHeight?: number })?.__mhHtmlHeight);
      if (h > 0) {
        el.style.height = `${Math.max(48, Math.min(Math.ceil(h), 4000))}px`;
        view.requestMeasure();
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
  return (
    <iframe
      ref={ref}
      class="html-frame"
      title="HTML 预览"
      sandbox="allow-scripts allow-popups"
      srcdoc={htmlSrcdoc(html)}
    />
  );
}

class VoidWidget extends WidgetType {
  dom: HTMLElement | null = null;
  ro: ResizeObserver | null = null;

  constructor(
    readonly kind: VoidKind,
    readonly source: string,
    readonly block: Block,
    readonly selected: boolean,
    readonly gen: number,
  ) {
    super();
  }

  private hasFocus(): boolean {
    return !!this.dom && this.dom.contains(this.dom.ownerDocument.activeElement);
  }

  override eq(other: VoidWidget): boolean {
    if (other.kind !== this.kind) return false;
    // Generation gates the focus special-case: an external change (remote merge,
    // undo/redo) intersecting the void bumps gen, so the island is torn down and
    // rebuilt from document truth even while focused. Data beats caret.
    if (other.gen !== this.gen) return false;
    if (this.hasFocus() || other.hasFocus()) {
      // Self write-back: keep the DOM (caret/IME). CM then ADOPTS the new widget
      // instance while keeping the old DOM — carry the dom pointer across so
      // hasFocus() stays answerable on the NEXT update too (the second keystroke
      // would otherwise compare two dom-less widgets, fail, and tear down the
      // focused island mid-typing).
      this.dom ??= other.dom;
      other.dom ??= this.dom;
      return true;
    }
    return other.source === this.source && other.selected === this.selected;
  }

  override toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("div");
    host.className = "cm-void cm-void-" + this.kind;
    host.contentEditable = "false";
    if (MEDIA.has(this.kind)) {
      // Click-to-select: ignoreEvent() leaves interior events to us, so without
      // this a click on an image would never move the CM selection and the
      // resize handles (shown only when `selected`) would be unreachable.
      // Interactive controls (preview button, resize handles, players, the file
      // card's <a>) keep their own behavior. preventDefault on mousedown does
      // NOT suppress a subsequent dblclick, so double-click preview still works.
      host.addEventListener("mousedown", (e) => {
        const t = e.target as HTMLElement | null;
        if (t?.closest("button, select, input, textarea, a, video, audio, .img-handle")) return;
        e.preventDefault();
        const v = voidUnder(view, host); // resolve fresh: positions shift as the user types
        if (!v) return;
        view.dispatch({ selection: { anchor: v.from, head: v.to } });
        view.focus();
      });
    }
    this.dom = host;
    render(this.component(view, host), host);
    this.ro = new ResizeObserver(() => view.requestMeasure());
    this.ro.observe(host);
    return host;
  }

  override destroy(dom: HTMLElement): void {
    this.ro?.disconnect();
    this.ro = null;
    render(null, dom); // unmount Preact → run effect cleanups (RO, listeners, flush registry)
    this.dom = null;
  }

  override ignoreEvent(): boolean {
    return true; // the interior owns its own events (buttons, cells, iframe)
  }

  override get estimatedHeight(): number {
    if (this.kind === "image") return this.block.width ? 220 : 200;
    if (this.kind === "table") return 120;
    return 160;
  }

  private component(view: EditorView, host: HTMLElement) {
    const writeBack = (b: Block) => commit(view, host, b);
    switch (this.kind) {
      case "image":
        return (
          <ImageBlock
            block={this.block}
            selected={this.selected}
            onResize={(w) => {
              this.block.width = w;
              writeBack(this.block);
            }}
            onPreview={() => view.state.facet(voidDeps).onPreviewImage?.(this.block)}
          />
        );
      case "video":
        return <VideoBlock block={this.block} />;
      case "audio":
        return <AudioBlock block={this.block} />;
      case "file":
        return <FileBlock block={this.block} />;
      case "code":
        // Always the editable island: clicking anywhere in the code body lands
        // in its textarea natively (host ignoreEvent leaves events to us).
        return (
          <CodeHost
            view={view}
            host={host}
            initial={this.block}
            source={this.source}
            selected={this.selected}
          />
        );
      case "html":
        return (
          <div class="void-block void-html">
            <div class="html-bar">
              <span class="html-tag">HTML</span>
              <button
                class="html-toggle"
                title="编辑源码"
                onMouseDown={(e) => {
                  e.preventDefault();
                  reveal(view, host);
                }}
              >
                源码
              </button>
            </div>
            <HtmlFrame html={this.block.content} view={view} />
          </div>
        );
      case "table":
        return <TableHost view={view} host={host} initial={this.block} />;
    }
  }
}

interface VoidState {
  deco: DecorationSet;
  atomic: RangeSet<Decoration>;
  /** Per-void generation, keyed by the void's `from`. Bumped whenever an EXTERNAL
   *  doc change (anything but our own `input.writeback`) intersects the void —
   *  the widget's eq() then fails and the island rebuilds from document truth. */
  gens: Map<number, number>;
}

function buildVoids(state: EditorState, gens: Map<number, number>): VoidState {
  const model = docModel(state);
  const sel = state.selection;
  const deco = new RangeSetBuilder<Decoration>();
  const atomic = new RangeSetBuilder<Decoration>();
  for (const v of model.voids) {
    const touched = sel.ranges.some((r) => r.from <= v.to && r.to >= v.from);
    if (v.kind === "html" && touched) continue; // reveal raw source (html only)
    const source = state.doc.sliceString(v.from, v.to);
    const selected = sel.ranges.some((r) => r.from <= v.from && r.to >= v.to);
    const gen = gens.get(v.from) ?? 0;
    deco.add(v.from, v.to, Decoration.replace({ block: true, widget: new VoidWidget(v.kind, source, v.block, selected, gen) }));
    if (ATOMIC.has(v.kind)) atomic.add(v.from, v.to, atomicMark);
  }
  return { deco: deco.finish(), atomic: atomic.finish(), gens };
}

/** Carry gens across a transaction: remap keys through the change set, then bump
 *  every void an external (non-writeback) change intersects. */
function nextGens(prev: Map<number, number>, tr: import("@codemirror/state").Transaction): Map<number, number> {
  const mapped = new Map<number, number>();
  for (const [from, gen] of prev) mapped.set(tr.changes.mapPos(from, 1), gen);
  if (!tr.isUserEvent("input.writeback")) {
    const model = docModel(tr.state);
    const hits: Array<[number, number]> = [];
    tr.changes.iterChanges((_fA, _tA, fB, tB) => hits.push([fB, tB]));
    for (const v of model.voids) {
      if (hits.some(([f, t]) => f <= v.to && t >= v.from)) {
        mapped.set(v.from, (mapped.get(v.from) ?? 0) + 1);
      }
    }
  }
  return mapped;
}

export const voidField = StateField.define<VoidState>({
  create: (state) => buildVoids(state, new Map()),
  update: (value, tr) => {
    if (!tr.docChanged && !tr.selection) return value;
    const gens = tr.docChanged ? nextGens(value.gens, tr) : value.gens;
    return buildVoids(tr.state, gens);
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
  ],
});
