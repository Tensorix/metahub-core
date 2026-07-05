/** @jsxImportSource preact */
// Floating format toolbar. Appears above a non-empty text selection with buttons
// that wrap the selected text in Markdown (bold / italic / inline-code / strike /
// link). Every command is an ordinary text transaction — no execCommand. The bar
// owns a `.pop` appended to document.body and positions it via the deferred coord
// read (coordsAtPos is illegal during an update).
//
// Show timing matches the old editor: the bar appears only AFTER the selection
// gesture completes (pointerup / keyup of Shift+Arrow), never while dragging.
// update() only hides and scroll-follows an already-visible bar.

import { render } from "preact";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { EditorSelection } from "@codemirror/state";
import { Icon } from "../../icons.tsx";
import { promptDialog } from "../../ui.tsx";
import { tokenizeInline, type InlineToken } from "../../inline-tokens.ts";
import { docModel } from "../doc-model";
import { deferCoords, cancelDeferred } from "../defer";

type Cmd = "bold" | "italic" | "code" | "strike" | "link";
const BUTTONS: { cmd: Cmd; icon: string; title: string }[] = [
  { cmd: "bold", icon: "bold", title: "加粗" },
  { cmd: "italic", icon: "italic", title: "斜体" },
  { cmd: "strike", icon: "strike", title: "删除线" },
  { cmd: "code", icon: "code", title: "行内代码" },
  { cmd: "link", icon: "link", title: "链接" },
];

const WRAP: Record<Exclude<Cmd, "link">, string> = { bold: "**", italic: "*", code: "`", strike: "~~" };
/** Command → the inline-token kind it toggles (grammar-true unwrap detection). */
const KIND: Record<Exclude<Cmd, "link">, InlineToken["kind"]> = {
  bold: "strong",
  italic: "em",
  code: "code",
  strike: "del",
};

/** True if the selection lies entirely inside a void's source range (skip the bar). */
function inVoid(view: EditorView, from: number, to: number): boolean {
  return docModel(view.state).voids.some((v) => from >= v.from && to <= v.to);
}

export function formatBar(): Extension {
  return ViewPlugin.fromClass(
    class {
      el: HTMLDivElement | null = null;
      raf = 0;
      dragging = false;

      onPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        this.dragging = true;
        this.hide();
      };

      onPointerUp = () => {
        this.dragging = false;
        if (!this.view.state.selection.main.empty) this.schedule();
      };

      onKeyUp = (e: KeyboardEvent) => {
        if (this.view.composing) return;
        // Selection gestures end on Shift release or arrow-key release. A plain
        // arrow collapses the selection — paint() then hides, which is correct.
        if (e.shiftKey || e.key.startsWith("Arrow")) this.schedule();
      };

      constructor(readonly view: EditorView) {
        view.contentDOM.addEventListener("pointerdown", this.onPointerDown);
        window.addEventListener("pointerup", this.onPointerUp);
        // A release outside the window never fires pointerup — without this the
        // `dragging` latch sticks and the bar can't show until the next click.
        window.addEventListener("pointercancel", this.onPointerUp);
        view.dom.addEventListener("keyup", this.onKeyUp);
      }

      schedule() {
        if (this.raf) return;
        this.raf = deferCoords(() => { this.raf = 0; this.paint(); });
      }

      update(u: ViewUpdate) {
        // Hide-only: never show the bar from update(); showing happens on
        // gesture completion (pointerup / keyup) instead.
        const emptied = u.selectionSet && u.state.selection.main.empty;
        if (u.docChanged || emptied || (u.focusChanged && !this.view.hasFocus)) {
          if (this.raf) { cancelDeferred(this.raf); this.raf = 0; }
          this.hide();
          return;
        }
        // Follow-only: reposition an already-visible bar on scroll/layout.
        if (this.el && (u.viewportChanged || u.geometryChanged)) this.schedule();
      }

      destroy() {
        this.view.contentDOM.removeEventListener("pointerdown", this.onPointerDown);
        window.removeEventListener("pointerup", this.onPointerUp);
        window.removeEventListener("pointercancel", this.onPointerUp);
        this.view.dom.removeEventListener("keyup", this.onKeyUp);
        if (this.raf) cancelDeferred(this.raf);
        this.hide();
      }

      async apply(cmd: Cmd) {
        const view = this.view;
        if (cmd === "link") {
          // URL dialog (old-editor behavior): a link with an empty target is
          // dead markup the user then has to hand-edit. Selection survives the
          // modal — CM keeps state while unfocused.
          const url = (await promptDialog({ title: "插入链接", label: "链接地址", placeholder: "https://…" }))?.trim();
          if (!url) { view.focus(); return; }
          const changes = view.state.changeByRange((r) => {
            const text = view.state.sliceDoc(r.from, r.to);
            const insert = `[${text}](${url})`;
            return {
              changes: { from: r.from, to: r.to, insert },
              range: EditorSelection.range(r.from + 1, r.from + 1 + text.length),
            };
          });
          view.dispatch(changes, { userEvent: "input.format", scrollIntoView: true });
          view.focus();
          return;
        }
        const changes = view.state.changeByRange((r) => {
          // TOGGLE, not blind wrap: if the selection sits in (or equals) an
          // existing token of this kind on its line, remove that token's
          // delimiters — clicking B on bold text un-bolds instead of piling up
          // `****text****`. Detection goes through the shared tokenizer, so it
          // can never disagree with what actually renders.
          const line = view.state.doc.lineAt(r.from);
          if (r.to <= line.to) {
            const t = tokenizeInline(line.text).find(
              (t) =>
                t.kind === KIND[cmd] &&
                ((line.from + t.innerFrom <= r.from && r.to <= line.from + t.innerTo) ||
                  (line.from + t.start === r.from && line.from + t.end === r.to)),
            );
            if (t) {
              const inner = line.text.slice(t.innerFrom, t.innerTo);
              return {
                changes: { from: line.from + t.start, to: line.from + t.end, insert: inner },
                range: EditorSelection.range(line.from + t.start, line.from + t.start + inner.length),
              };
            }
          }
          const text = view.state.sliceDoc(r.from, r.to);
          const w = WRAP[cmd];
          const insert = `${w}${text}${w}`;
          return {
            changes: { from: r.from, to: r.to, insert },
            range: EditorSelection.range(r.from + w.length, r.from + w.length + text.length),
          };
        });
        view.dispatch(changes, { userEvent: "input.format", scrollIntoView: true });
        view.focus();
      }

      paint() {
        const view = this.view;
        const sel = view.state.selection.main;
        if (this.dragging || sel.empty || !view.hasFocus || inVoid(view, sel.from, sel.to)) return this.hide();
        // Old-editor semantics: anchor to the first selection rect's top-left
        // (the bar sits above the selection start), not the midpoint.
        const head = Math.min(sel.from, sel.to);
        const coords = view.coordsAtPos(head, 1);
        if (!coords) return this.hide();
        if (!this.el) {
          const el = document.createElement("div");
          el.className = "pop cm-format-bar";
          el.style.zIndex = "95";
          el.addEventListener("mousedown", (e) => e.preventDefault());
          document.body.appendChild(el);
          this.el = el;
        }
        const el = this.el;
        render(
          <>
            {BUTTONS.map((btn) => (
              <button
                key={btn.cmd}
                class="item"
                style={{ width: "34px", justifyContent: "center", padding: "7px 0" }}
                title={btn.title}
                onMouseDown={(e) => { e.preventDefault(); void this.apply(btn.cmd); }}
              >
                <Icon name={btn.icon} cls="ico sm" />
              </button>
            ))}
          </>,
          el,
        );
        // Compact horizontal toolbar (the .pop .item defaults are for vertical menus).
        // minWidth 0 overrides .pop's min-width:232px — the bar hugs its buttons.
        el.style.display = "flex";
        el.style.gap = "1px";
        el.style.padding = "3px";
        el.style.minWidth = "0";
        el.style.left = `${Math.max(8, Math.min(coords.left, innerWidth - el.offsetWidth - 8))}px`;
        el.style.top = `${Math.max(8, coords.top - el.offsetHeight - 6)}px`;
        el.style.bottom = "";
      }

      hide() {
        if (this.el) { render(null, this.el); this.el.remove(); this.el = null; }
      }
    },
  );
}
