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
//   • ATOMIC (media, table): the caret can never land inside; the widget is always
//     present. Media "selected" = the CM selection spans the whole range (resize
//     handles show). Tables edit in place inside a contenteditable island.
//   • REVEAL-TO-EDIT (code, html): NOT atomic. When the selection touches the range
//     the widget is dropped and the raw Markdown source shows for editing; clicking
//     the display dispatches a selection into it to trigger the reveal.
//
// Write-back: when a hosted component mutates its block (image resize, code lang,
// table cell), it re-serializes via blockToText and dispatches ONE change over the
// void's CURRENT range (located with posAtDOM). The widget's eq() returns true
// while its DOM holds focus, so that self-authored change never tears down the
// caret/IME. A flush registry drains debounced table edits before a save.

import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { StateField, RangeSetBuilder, type EditorState, type RangeSet } from "@codemirror/state";
import { docModel } from "../doc-model";
import { voidAt, type VoidKind } from "../blockmodel";
import { blockToText, type Block } from "../../blocks";
import { ImageBlock, VideoBlock, AudioBlock, FileBlock } from "../../media/media-blocks";
import { CodeDisplay } from "../../media/code-block";
import { TableBlock } from "../../media/table-block";
import type { CellSel } from "../../cell-select";

const ATOMIC = new Set<VoidKind>(["image", "video", "audio", "file", "table"]);
const atomicMark = Decoration.mark({});

// ---- flush registry (drain debounced table edits before save) ----
const flushers = new Set<() => void>();
function registerFlush(fn: () => void): () => void {
  flushers.add(fn);
  return () => flushers.delete(fn);
}
/** Commit every pending in-widget edit to the document. Call before snapshot/save. */
export function flushVoids(): void {
  for (const f of [...flushers]) f();
}

const REPORTER = `<script>(function(){function r(){try{parent.postMessage({__mhHtmlHeight:document.documentElement.scrollHeight},'*')}catch(e){}}try{new ResizeObserver(r).observe(document.documentElement)}catch(e){}addEventListener('load',r);setTimeout(r,60);setTimeout(r,400)})();<\/script>`;
function htmlSrcdoc(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>html,body{margin:0;padding:0;color-scheme:light dark;font-family:system-ui,-apple-system,sans-serif}</style></head><body>${html}${REPORTER}</body></html>`;
}

/** Locate the void currently under `host` and replace its whole source range with
 *  the re-serialized block, unless the text is already identical. */
function commit(view: EditorView, host: HTMLElement, block: Block) {
  const from = view.posAtDOM(host);
  const model = docModel(view.state);
  const v = voidAt(model, from) ?? voidAt(model, from + 1);
  if (!v) return;
  const md = blockToText(block);
  if (md === view.state.sliceDoc(v.from, v.to)) return;
  view.dispatch({ changes: { from: v.from, to: v.to, insert: md }, userEvent: "input.writeback" });
}

/** Move the caret into the void's content (line after the opening fence) to trigger
 *  reveal-to-edit for code/html. */
function reveal(view: EditorView, host: HTMLElement) {
  const from = view.posAtDOM(host);
  const model = docModel(view.state);
  const v = voidAt(model, from) ?? voidAt(model, from + 1);
  if (!v) return;
  const open = view.state.doc.lineAt(v.from);
  const anchor = Math.min(open.to + 1, v.to);
  view.dispatch({ selection: { anchor }, scrollIntoView: true });
  view.focus();
}

// ---- in-place editable table host ----
function TableHost({ view, host, initial }: { view: EditorView; host: HTMLElement; initial: Block }) {
  const bRef = useRef<Block>(structuredClone(initial));
  const [cellSel, setCellSel] = useState<CellSel | null>(null);
  const [rk, setRk] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const flush = () => {
    clearTimeout(timer.current);
    commit(view, host, bRef.current);
  };
  const schedule = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 300);
  };

  useEffect(() => registerFlush(flush), []);

  return (
    <TableBlock
      block={bRef.current}
      renderKey={rk}
      cellSel={cellSel}
      onCellSel={setCellSel}
      onCellInput={(r, c, v) => {
        const rows = bRef.current.rows ?? [];
        if (rows[r]) rows[r]![c] = v;
        schedule();
      }}
      onTableChange={() => {
        setRk((k) => k + 1);
        flush();
      }}
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
  ) {
    super();
  }

  private hasFocus(): boolean {
    return !!this.dom && this.dom.contains(this.dom.ownerDocument.activeElement);
  }

  override eq(other: VoidWidget): boolean {
    if (other.kind !== this.kind) return false;
    if (this.hasFocus()) return true; // never tear down a focused island (write-back)
    return other.source === this.source && other.selected === this.selected;
  }

  override toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("div");
    host.className = "cm-void cm-void-" + this.kind;
    host.contentEditable = "false";
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
            onPreview={() => {}}
          />
        );
      case "video":
        return <VideoBlock block={this.block} />;
      case "audio":
        return <AudioBlock block={this.block} />;
      case "file":
        return <FileBlock block={this.block} />;
      case "code":
        // Clicking the code body (not the tools) reveals raw source for editing.
        host.addEventListener("mousedown", (e) => {
          if ((e.target as HTMLElement).closest(".code-tools")) return;
          e.preventDefault();
          reveal(view, host);
        });
        return (
          <CodeDisplay
            code={this.block.content}
            lang={this.block.lang}
            onLang={(l) => {
              this.block.lang = l;
              writeBack(this.block);
            }}
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
            <iframe
              class="html-frame"
              title="HTML 预览"
              sandbox="allow-scripts allow-popups"
              srcdoc={htmlSrcdoc(this.block.content)}
              ref={(el) => {
                if (!el) return;
                const onMsg = (e: MessageEvent) => {
                  if (e.source === el.contentWindow) {
                    const h = Number((e.data as { __mhHtmlHeight?: number })?.__mhHtmlHeight);
                    if (h > 0) {
                      el.style.height = `${Math.max(48, Math.min(Math.ceil(h), 4000))}px`;
                      view.requestMeasure();
                    }
                  }
                };
                window.addEventListener("message", onMsg);
              }}
            />
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
}

function buildVoids(state: EditorState): VoidState {
  const model = docModel(state);
  const sel = state.selection;
  const deco = new RangeSetBuilder<Decoration>();
  const atomic = new RangeSetBuilder<Decoration>();
  for (const v of model.voids) {
    const touched = sel.ranges.some((r) => r.from <= v.to && r.to >= v.from);
    if ((v.kind === "code" || v.kind === "html") && touched) continue; // reveal raw source
    const source = state.doc.sliceString(v.from, v.to);
    const selected = sel.ranges.some((r) => r.from <= v.from && r.to >= v.to);
    deco.add(v.from, v.to, Decoration.replace({ block: true, widget: new VoidWidget(v.kind, source, v.block, selected) }));
    if (ATOMIC.has(v.kind)) atomic.add(v.from, v.to, atomicMark);
  }
  return { deco: deco.finish(), atomic: atomic.finish() };
}

export const voidField = StateField.define<VoidState>({
  create: (state) => buildVoids(state),
  update: (value, tr) => (tr.docChanged || tr.selection ? buildVoids(tr.state) : value),
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
  ],
});
