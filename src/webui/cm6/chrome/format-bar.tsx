/** @jsxImportSource preact */
// Floating format toolbar. Appears above a non-empty text selection with buttons
// that wrap the selected text in Markdown (bold / italic / inline-code / strike /
// link). Every command is an ordinary text transaction — no execCommand. The bar
// owns a `.pop` appended to document.body and positions it via the deferred coord
// read (coordsAtPos is illegal during an update).

import { render } from "preact";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { EditorSelection } from "@codemirror/state";
import { Icon } from "../../icons.tsx";
import { docModel } from "../doc-model";
import { deferCoords } from "../defer";

type Cmd = "bold" | "italic" | "code" | "strike" | "link";
const BUTTONS: { cmd: Cmd; icon: string; title: string }[] = [
  { cmd: "bold", icon: "bold", title: "加粗" },
  { cmd: "italic", icon: "italic", title: "斜体" },
  { cmd: "strike", icon: "strikethrough", title: "删除线" },
  { cmd: "code", icon: "code", title: "行内代码" },
  { cmd: "link", icon: "link", title: "链接" },
];

const WRAP: Record<Exclude<Cmd, "link">, string> = { bold: "**", italic: "*", code: "`", strike: "~~" };

/** True if the selection lies entirely inside a void's source range (skip the bar). */
function inVoid(view: EditorView, from: number, to: number): boolean {
  return docModel(view.state).voids.some((v) => from >= v.from && to <= v.to);
}

export function formatBar(): Extension {
  return ViewPlugin.fromClass(
    class {
      el: HTMLDivElement | null = null;
      raf = 0;
      constructor(readonly view: EditorView) {}

      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.focusChanged || u.viewportChanged || u.geometryChanged) {
          if (this.raf) return;
          this.raf = deferCoords(() => { this.raf = 0; this.paint(); });
        }
      }

      destroy() {
        if (this.raf) cancelAnimationFrame(this.raf);
        this.hide();
      }

      apply(cmd: Cmd) {
        const view = this.view;
        const changes = view.state.changeByRange((r) => {
          const text = view.state.sliceDoc(r.from, r.to);
          if (cmd === "link") {
            const insert = `[${text}]()`;
            const caret = r.from + text.length + 3; // inside the ()
            return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(caret) };
          }
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
        if (sel.empty || !view.hasFocus || inVoid(view, sel.from, sel.to)) return this.hide();
        const a = view.coordsAtPos(sel.from);
        const b = view.coordsAtPos(sel.to);
        if (!a || !b) return this.hide();
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
              <button key={btn.cmd} class="item" title={btn.title} onMouseDown={(e) => { e.preventDefault(); this.apply(btn.cmd); }}>
                <Icon name={btn.icon} cls="ico sm" />
              </button>
            ))}
          </>,
          el,
        );
        el.style.display = "flex";
        const midX = (a.left + b.right) / 2;
        const top = Math.min(a.top, b.top);
        el.style.left = `${Math.max(8, Math.min(midX - el.offsetWidth / 2, innerWidth - el.offsetWidth - 8))}px`;
        el.style.top = `${Math.max(8, top - el.offsetHeight - 6)}px`;
        el.style.bottom = "";
      }

      hide() {
        if (this.el) { render(null, this.el); this.el.remove(); this.el = null; }
      }
    },
  );
}
