/** @jsxImportSource preact */
// Find-in-document (Mod-f). In the single-document model a match is a plain text
// offset span, so matches paint as `Decoration.mark`s directly over the doc — no
// DOM/Highlight-API gymnastics. A small bar (top-right) holds the term + options +
// n/m + prev/next; Enter / Shift-Enter step, Esc closes. Reuses find.ts's matcher.

import { render } from "preact";
import { Decoration, EditorView, ViewPlugin, keymap } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { Icon } from "../../icons.tsx";
import { findInText, type FindOpts } from "../../find.ts";

const MARK = Decoration.mark({ class: "cm-find" });
const CUR = Decoration.mark({ class: "cm-find cm-find-cur" });

// Compact toolbar buttons: the `.pop .item` defaults (width:100%) are for vertical
// menus and would stretch each button across the bar.
const FIND_BTN = { width: "28px", minWidth: "28px", justifyContent: "center", padding: "5px 0" };

const findPlugin = ViewPlugin.fromClass(
  class {
    open = false;
    term = "";
    opts: FindOpts = { caseSensitive: false, wholeWord: false };
    matches: Array<[number, number]> = [];
    idx = 0;
    deco: DecorationSet = Decoration.none;
    bar: HTMLDivElement | null = null;

    constructor(readonly view: EditorView) {}

    update(u: ViewUpdate) {
      if (u.docChanged && this.open) this.recompute(false);
    }

    destroy() { this.hideBar(); }

    show() {
      this.open = true;
      this.recompute(true);
      this.drawBar();
      requestAnimationFrame(() => this.bar?.querySelector("input")?.focus());
    }

    close() {
      this.open = false;
      this.term = "";
      this.matches = [];
      this.deco = Decoration.none;
      this.hideBar();
      this.view.dispatch({}); // repaint to clear decorations
      this.view.focus();
    }

    setTerm(term: string) { this.term = term; this.idx = 0; this.recompute(true); this.drawBar(); }
    toggle(k: keyof FindOpts) { this.opts = { ...this.opts, [k]: !this.opts[k] }; this.recompute(true); this.drawBar(); }

    step(dir: 1 | -1) {
      if (!this.matches.length) return;
      this.idx = (this.idx + dir + this.matches.length) % this.matches.length;
      this.scrollToCurrent();
      this.recompute(false);
      this.drawBar();
    }

    private recompute(resetScroll: boolean) {
      this.matches = this.term ? findInText(this.view.state.doc.toString(), this.term, this.opts) : [];
      if (this.idx >= this.matches.length) this.idx = 0;
      const b = [] as Array<import("@codemirror/state").Range<Decoration>>;
      this.matches.forEach(([f, t], i) => b.push((i === this.idx ? CUR : MARK).range(f, t)));
      this.deco = Decoration.set(b, true);
      this.view.dispatch({}); // trigger a decoration repaint
      if (resetScroll) this.scrollToCurrent();
    }

    private scrollToCurrent() {
      const m = this.matches[this.idx];
      if (m) this.view.dispatch({ effects: EditorView.scrollIntoView(m[0], { y: "center" }) });
    }

    private drawBar() {
      if (!this.bar) {
        const el = document.createElement("div");
        el.className = "cm-find-bar pop";
        el.style.cssText = "position:fixed;top:14px;right:18px;z-index:96;display:flex;align-items:center;gap:6px;padding:5px 8px";
        el.addEventListener("mousedown", (e) => { if ((e.target as HTMLElement).tagName !== "INPUT") e.preventDefault(); });
        document.body.appendChild(el);
        this.bar = el;
      }
      render(
        <>
          <input
            class="cm-find-input"
            placeholder="查找…"
            value={this.term}
            onInput={(e) => this.setTerm((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
              else if (e.key === "Escape") { e.preventDefault(); this.close(); }
            }}
          />
          <span class="cm-find-count">{this.matches.length ? `${this.idx + 1}/${this.matches.length}` : "0/0"}</span>
          <button class={"item" + (this.opts.caseSensitive ? " on" : "")} style={FIND_BTN} title="区分大小写" onClick={() => this.toggle("caseSensitive")}>Aa</button>
          <button class={"item" + (this.opts.wholeWord ? " on" : "")} style={FIND_BTN} title="全词匹配" onClick={() => this.toggle("wholeWord")}>W</button>
          <button class="item" style={FIND_BTN} title="上一个" onClick={() => this.step(-1)}><Icon name="chevronUp" cls="ico sm" /></button>
          <button class="item" style={FIND_BTN} title="下一个" onClick={() => this.step(1)}><Icon name="chevronDown" cls="ico sm" /></button>
          <button class="item" style={FIND_BTN} title="关闭" onClick={() => this.close()}><Icon name="x" cls="ico sm" /></button>
        </>,
        this.bar,
      );
    }

    private hideBar() { if (this.bar) { render(null, this.bar); this.bar.remove(); this.bar = null; } }
  },
  { decorations: (v) => v.deco },
);

export function find(): Extension {
  return [
    findPlugin,
    keymap.of([
      { key: "Mod-f", run: (view) => { view.plugin(findPlugin)?.show(); return true; } },
      { key: "Escape", run: (view) => { const p = view.plugin(findPlugin); if (p?.open) { p.close(); return true; } return false; } },
    ]),
  ];
}
