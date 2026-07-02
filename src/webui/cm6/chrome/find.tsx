/** @jsxImportSource preact */
// Find-in-document (Mod-f). In the single-document model a match is a plain text
// offset span, so matches paint as `Decoration.mark`s directly over the doc — no
// DOM/Highlight-API gymnastics. A small bar (top-right) holds the term + options +
// n/m + prev/next; Enter / Shift-Enter step, Esc closes. Reuses find.ts's matcher.
//
// State lives in a StateField driven by StateEffects: decorations are recomputed
// inside the field's update (a pure function of the transaction), never by
// dispatching from plugin update() — CM6 forbids reentrant dispatch there, and the
// old ViewPlugin version crashed (and got deactivated) on the first doc change
// while the bar was open. The bar itself is a render-only ViewPlugin.

import { render } from "preact";
import { Decoration, EditorView, ViewPlugin, keymap } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Icon } from "../../icons.tsx";
import { findInText, type FindOpts } from "../../find.ts";

const MARK = Decoration.mark({ class: "cm-find" });
const CUR = Decoration.mark({ class: "cm-find cm-find-cur" });

interface FindState {
  term: string;
  opts: FindOpts;
  idx: number;
  matches: Array<[number, number]>;
  deco: DecorationSet;
}

const openFind = StateEffect.define<null>();
const closeFind = StateEffect.define<null>();
const setFind = StateEffect.define<{ term?: string; opts?: FindOpts }>();
const stepFind = StateEffect.define<1 | -1>();

function compute(doc: string, term: string, opts: FindOpts, idx: number): FindState {
  const matches = term ? findInText(doc, term, opts) : [];
  if (idx >= matches.length) idx = 0;
  const ranges = matches.map(([f, t], i) => (i === idx ? CUR : MARK).range(f, t));
  return { term, opts, idx, matches, deco: Decoration.set(ranges, true) };
}

export const findField = StateField.define<FindState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(closeFind)) return null;
      if (e.is(openFind)) {
        value ??= { term: "", opts: { caseSensitive: false, wholeWord: false }, idx: 0, matches: [], deco: Decoration.none };
      }
      if (e.is(setFind) && value) {
        value = compute(tr.state.doc.toString(), e.value.term ?? value.term, e.value.opts ?? value.opts, 0);
      }
      if (e.is(stepFind) && value && value.matches.length) {
        const idx = (value.idx + e.value + value.matches.length) % value.matches.length;
        value = compute(tr.state.doc.toString(), value.term, value.opts, idx);
      }
    }
    if (value && tr.docChanged && !tr.effects.some((e) => e.is(setFind) || e.is(stepFind))) {
      value = compute(tr.state.doc.toString(), value.term, value.opts, value.idx);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v?.deco ?? Decoration.none),
});

/** Scroll the current match into view — called from event handlers only (a fresh
 *  dispatch is legal there, not inside field/plugin update). */
function scrollToCurrent(view: EditorView) {
  const s = view.state.field(findField);
  const m = s?.matches[s.idx];
  if (m) view.dispatch({ effects: EditorView.scrollIntoView(m[0], { y: "center" }) });
}

// Compact toolbar buttons: the `.pop .item` defaults (width:100%) are for vertical
// menus and would stretch each button across the bar.
const FIND_BTN = { width: "28px", minWidth: "28px", justifyContent: "center", padding: "5px 0" };

/** Render-only bar: mounts/unmounts on field presence, re-renders when the field
 *  value changes. Never dispatches from update() — handlers do. */
const findBar = ViewPlugin.fromClass(
  class {
    bar: HTMLDivElement | null = null;
    last: FindState | null = null;

    constructor(readonly view: EditorView) {}

    update(u: ViewUpdate) {
      const s = u.state.field(findField);
      if (s === this.last) return;
      this.last = s;
      if (s) this.draw(s);
      else this.hide();
    }

    destroy() { this.hide(); }

    private draw(s: FindState) {
      const view = this.view;
      const firstDraw = !this.bar;
      if (!this.bar) {
        const el = document.createElement("div");
        el.className = "cm-find-bar pop";
        el.addEventListener("mousedown", (e) => { if ((e.target as HTMLElement).tagName !== "INPUT") e.preventDefault(); });
        document.body.appendChild(el);
        this.bar = el;
      }
      const step = (dir: 1 | -1) => { view.dispatch({ effects: stepFind.of(dir) }); scrollToCurrent(view); };
      const toggle = (k: keyof FindOpts) => {
        const cur = view.state.field(findField);
        if (!cur) return;
        view.dispatch({ effects: setFind.of({ opts: { ...cur.opts, [k]: !cur.opts[k] } }) });
        scrollToCurrent(view);
      };
      const close = () => { view.dispatch({ effects: closeFind.of(null) }); view.focus(); };
      render(
        <>
          <input
            class="cm-find-input"
            placeholder="查找…"
            value={s.term}
            onInput={(e) => {
              view.dispatch({ effects: setFind.of({ term: (e.currentTarget as HTMLInputElement).value }) });
              scrollToCurrent(view);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
              else if (e.key === "Escape") { e.preventDefault(); close(); }
            }}
          />
          <span class="cm-find-count">{s.matches.length ? `${s.idx + 1}/${s.matches.length}` : "0/0"}</span>
          <button class={"item" + (s.opts.caseSensitive ? " on" : "")} style={FIND_BTN} title="区分大小写" onClick={() => toggle("caseSensitive")}>Aa</button>
          <button class={"item" + (s.opts.wholeWord ? " on" : "")} style={FIND_BTN} title="全词匹配" onClick={() => toggle("wholeWord")}>W</button>
          <button class="item" style={FIND_BTN} title="上一个" onClick={() => step(-1)}><Icon name="chevronUp" cls="ico sm" /></button>
          <button class="item" style={FIND_BTN} title="下一个" onClick={() => step(1)}><Icon name="chevronDown" cls="ico sm" /></button>
          <button class="item" style={FIND_BTN} title="关闭" onClick={close}><Icon name="x" cls="ico sm" /></button>
        </>,
        this.bar,
      );
      if (firstDraw) requestAnimationFrame(() => this.bar?.querySelector("input")?.focus());
    }

    private hide() { if (this.bar) { render(null, this.bar); this.bar.remove(); this.bar = null; } }
  },
);

export function find(): Extension {
  return [
    findField,
    findBar,
    keymap.of([
      {
        key: "Mod-f",
        run: (view) => {
          view.dispatch({ effects: openFind.of(null) });
          requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".cm-find-bar input")?.focus());
          return true;
        },
      },
      {
        key: "Escape",
        run: (view) => {
          if (!view.state.field(findField)) return false;
          view.dispatch({ effects: closeFind.of(null) });
          return true;
        },
      },
    ]),
  ];
}
