/** @jsxImportSource preact */
// Floating table-of-contents. A fixed right-gutter nav (reusing the app's .doc-toc
// styles) built from the document's h1–h6 lines in the derived model, with a
// scroll-spy that highlights the heading nearest the top of the viewport. Clicking
// an entry scrolls it to the top and drops the caret there. Owns a <nav> appended
// to view.dom; all coord reads go through the deferred path.

import { render } from "preact";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { PluginValue, ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { docModel } from "../doc-model";
import type { DocHeading } from "../blockmodel";
import { deferCoords } from "../defer";
import { stripInlineTokens } from "../../inline-tokens";

interface Heading { from: number; level: number; text: string; }

/** Display headings from the model's pre-extracted raw headings (no line walk;
 *  only the inline-token strip runs here). */
function collect(view: EditorView): Heading[] {
  return docModel(view.state).headings.map((h) => ({
    from: h.from,
    level: h.level,
    text: stripInlineTokens(h.text).trim() || "无标题",
  }));
}

const keyOf = (hs: Heading[]) => hs.map((h) => `${h.from}:${h.level}:${h.text}`).join("\n");

class TocPlugin implements PluginValue {
  private host: HTMLElement;
  private headings: Heading[];
  private raw: ReadonlyArray<DocHeading>;
  private key: string;
  private active = 0;
  private raf = 0;
  private destroyed = false;

  constructor(readonly view: EditorView) {
    this.host = document.createElement("nav");
    this.host.className = "doc-toc";
    this.host.setAttribute("aria-label", "文档目录");
    view.dom.appendChild(this.host);
    this.raw = docModel(view.state).headings;
    this.headings = collect(view);
    this.key = keyOf(this.headings);
    this.draw();
    window.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
    deferCoords(() => this.recompute());
  }

  update(u: ViewUpdate) {
    if (u.docChanged) {
      // patchScan reuses the headings array (by reference) when nothing heading-
      // related changed — the common keystroke path skips collect() entirely.
      const raw = docModel(u.view.state).headings;
      if (raw !== this.raw) {
        this.raw = raw;
        const next = collect(u.view);
        const key = keyOf(next);
        if (key !== this.key) {
          this.key = key; this.headings = next;
          if (this.active >= next.length) this.active = Math.max(0, next.length - 1);
          this.draw();
        }
      }
      this.schedule();
    } else if (u.viewportChanged || u.geometryChanged) {
      this.schedule();
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    window.removeEventListener("scroll", this.onScroll, { capture: true } as EventListenerOptions);
    render(null, this.host);
    this.host.remove();
  }

  private onScroll = () => this.schedule();

  private schedule() {
    if (this.raf) return;
    this.raf = deferCoords(() => { this.raf = 0; this.recompute(); });
  }

  private recompute() {
    if (this.destroyed || !this.headings.length) return;
    const ref = Math.max(this.view.scrollDOM.getBoundingClientRect().top, 0) + 100;
    const vp = this.view.viewport;
    let active = 0;
    for (let i = 0; i < this.headings.length; i++) {
      const from = this.headings[i]!.from;
      const c = this.view.coordsAtPos(from);
      if (!c) { if (from < vp.from) { active = i; continue; } break; }
      if (c.top - ref <= 1) active = i; else break;
    }
    if (active !== this.active) { this.active = active; this.draw(); }
  }

  private jump = (from: number) => {
    this.view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: "start" }) });
    this.view.focus();
  };

  private draw() {
    render(
      <>
        {this.headings.map((h, i) => (
          <button
            key={h.from}
            type="button"
            class={`toc-row lvl-${h.level}${i === this.active ? " active" : ""}`}
            title={h.text}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => this.jump(h.from)}
          >
            <span class="toc-tick" />
            <span class="toc-label">{h.text}</span>
          </button>
        ))}
      </>,
      this.host,
    );
  }
}

export function docToc(): Extension {
  return ViewPlugin.fromClass(TocPlugin);
}
