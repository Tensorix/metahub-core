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
import { consumeKey } from "../../keys.ts";
import { findInText, collectMatches, applyHighlights, clearHighlights, type FindOpts } from "../../find.ts";

const MARK = Decoration.mark({ class: "cm-find" });
const CUR = Decoration.mark({ class: "cm-find cm-find-cur" });

interface FindState {
  term: string;
  opts: FindOpts;
  idx: number;
  matches: Array<[number, number]>;
  deco: DecorationSet;
}

export const openFind = StateEffect.define<null>();
const closeFind = StateEffect.define<null>();
export const setFind = StateEffect.define<{ term?: string; opts?: FindOpts }>();
const stepFind = StateEffect.define<1 | -1>();

function compute(doc: string, term: string, opts: FindOpts, idx: number): FindState {
  const matches = term ? findInText(doc, term, opts) : [];
  return withMatches(term, opts, idx, matches);
}

function withMatches(term: string, opts: FindOpts, idx: number, matches: Array<[number, number]>): FindState {
  if (idx >= matches.length) idx = 0;
  const ranges = matches.map(([f, t], i) => (i === idx ? CUR : MARK).range(f, t));
  return { term, opts, idx, matches, deco: Decoration.set(ranges, true) };
}

/** Recompute after a doc change WITHOUT re-searching the whole document (the
 *  old full `doc.toString()` + rescan ran synchronously inside dispatch on
 *  every keystroke while the bar was open). Matches clear of the edit are
 *  mapped through the changes; only a window around the damage — padded by the
 *  term length plus one wholeWord boundary char — is re-searched. */
export function remapMatches(prev: FindState, tr: import("@codemirror/state").Transaction): FindState {
  const { term, opts } = prev;
  if (!term) return withMatches(term, opts, prev.idx, []);
  let lo = Infinity;
  let hi = -1;
  tr.changes.iterChanges((_fA, _tA, fB, tB) => {
    if (fB < lo) lo = fB;
    if (tB > hi) hi = tB;
  });
  if (hi < 0) return prev;
  const doc = tr.state.doc;
  // A match is damage-affected iff it intersects [lo-1, hi+1] (±1: an edit can
  // flip a wholeWord verdict via the boundary char). Everything else survives
  // by position mapping.
  const zoneFrom = lo - 1;
  const zoneTo = hi + 1;
  const matches: Array<[number, number]> = [];
  for (const [s, e] of prev.matches) {
    const ns = tr.changes.mapPos(s, 1);
    const ne = tr.changes.mapPos(e, -1);
    if (ne - ns !== e - s) continue; // clipped/deleted by the edit
    if (ns <= zoneTo && ne >= zoneFrom) continue; // affected → rediscovered below
    matches.push([ns, ne]);
  }
  // Re-search a slice that fully contains every affected match plus the
  // context chars wholeWord needs at both ends.
  const ctxFrom = Math.max(0, lo - term.length - 2);
  const ctxTo = Math.min(doc.length, hi + term.length + 2);
  const slice = doc.sliceString(ctxFrom, ctxTo);
  for (const [s, e] of findInText(slice, term, opts)) {
    const as = ctxFrom + s;
    const ae = ctxFrom + e;
    // Slice-edge matches: only trust wholeWord verdicts with real context
    // inside the slice (doc edges excepted — there the slice edge IS the doc
    // edge, so out-of-bounds counts as a boundary either way).
    if (opts.wholeWord && ((as === ctxFrom && ctxFrom > 0) || (ae === ctxTo && ctxTo < doc.length))) continue;
    if (as <= zoneTo && ae >= zoneFrom) matches.push([as, ae]);
  }
  matches.sort((a, b) => a[0] - b[0]);
  return withMatches(term, opts, prev.idx, matches);
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
      value = remapMatches(value, tr);
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

/** Render-only bar: mounts/unmounts on field presence, re-renders when the field
 *  value changes. Never dispatches from update() — handlers do. */
const findBar = ViewPlugin.fromClass(
  class {
    bar: HTMLDivElement | null = null;
    last: FindState | null = null;
    islandRaf = 0;

    constructor(readonly view: EditorView) {}

    update(u: ViewUpdate) {
      const s = u.state.field(findField);
      // Matches inside void widgets (code mirror, table cells) are swallowed by
      // the block replace decoration — paint them with the CSS Custom Highlight
      // API over the rendered widget DOM instead (find.ts, the old editor's
      // mechanism). Repaint whenever the field, the doc, or the set of mounted
      // widgets (viewport) changes.
      if (s?.term && (s !== this.last || u.docChanged || u.viewportChanged || u.geometryChanged)) {
        this.scheduleIslands(s);
      } else if (!s?.term && this.last?.term) {
        this.scheduleIslands(null);
      }
      if (s === this.last) return;
      this.last = s;
      if (s) this.draw(s);
      else this.hide();
    }

    destroy() {
      this.hide();
      if (this.islandRaf) cancelAnimationFrame(this.islandRaf);
      clearHighlights();
    }

    /** Deferred (rAF): widget DOM mounts after the CM update finishes, and DOM
     *  walking is illegal inside update() anyway. */
    private scheduleIslands(s: FindState | null) {
      if (this.islandRaf) cancelAnimationFrame(this.islandRaf);
      this.islandRaf = requestAnimationFrame(() => {
        this.islandRaf = 0;
        if (!s?.term) return clearHighlights();
        applyHighlights(collectMatches(this.view.contentDOM, s.term, s.opts), null);
      });
    }

    private draw(s: FindState) {
      const view = this.view;
      const firstDraw = !this.bar;
      if (!this.bar) {
        const el = document.createElement("div");
        el.className = "find-bar";
        el.setAttribute("role", "search");
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
          <Icon name="search" cls="ico sm find-ico" />
          <input
            type="text"
            placeholder="在文档中查找"
            value={s.term}
            onInput={(e) => {
              view.dispatch({ effects: setFind.of({ term: (e.currentTarget as HTMLInputElement).value }) });
              scrollToCurrent(view);
            }}
            onKeyDown={(e) => {
              // consumeKey (not bare preventDefault): the quicknote window hides
              // on any unconsumed bubbled Escape.
              if (e.key === "Enter") { consumeKey(e); step(e.shiftKey ? -1 : 1); }
              else if (e.key === "Escape") { consumeKey(e); close(); }
            }}
          />
          <span class="find-count">{s.matches.length ? `${s.idx + 1} / ${s.matches.length}` : (s.term ? "无结果" : "")}</span>
          <button class={"find-opt" + (s.opts.caseSensitive ? " on" : "")} title="区分大小写" onClick={() => toggle("caseSensitive")}>Aa</button>
          <button class={"find-opt" + (s.opts.wholeWord ? " on" : "")} title="全词匹配" onClick={() => toggle("wholeWord")}>全词</button>
          <button class="find-nav" title="上一个 (Shift+Enter)" disabled={!s.matches.length} onClick={() => step(-1)}>
            <Icon name="chevronDown" cls="ico sm find-prev" />
          </button>
          <button class="find-nav" title="下一个 (Enter)" disabled={!s.matches.length} onClick={() => step(1)}>
            <Icon name="chevronDown" cls="ico sm" />
          </button>
          <button class="find-nav find-close" title="关闭 (Esc)" onClick={close}>
            <Icon name="x" cls="ico sm" />
          </button>
        </>,
        this.bar,
      );
      if (firstDraw) requestAnimationFrame(() => this.bar?.querySelector("input")?.focus());
    }

    private hide() { if (this.bar) { render(null, this.bar); this.bar.remove(); this.bar = null; } }
  },
);

/** Open the in-document find bar and focus its input. Exported so the window-
 *  level Cmd+F fallback (editor.tsx) can open it when CM doesn't have focus —
 *  the CM keymap alone only fires with focus in contentDOM, and browser-native
 *  find is useless against CM's viewport-only rendering. */
export function openDocFind(view: EditorView): void {
  view.dispatch({ effects: openFind.of(null) });
  requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".find-bar input")?.focus());
}

export function find(): Extension {
  return [
    findField,
    findBar,
    keymap.of([
      {
        key: "Mod-f",
        run: (view) => {
          openDocFind(view);
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
