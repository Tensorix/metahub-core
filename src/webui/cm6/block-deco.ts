// Block-level line decorations for the single-document editor.
//
// This ViewPlugin turns each visible line's derived role (blockmodel.ts) into the
// WYSIWYG presentation of a Notion-style block WITHOUT ever leaving the source
// model: headings get a size class and their `# ` collapses, quotes get a rule and
// their `> ` collapses, dividers render as a horizontal rule, list lines get their
// leading whitespace hidden + a per-level padding indent, bullets show a glyph,
// ordered items show their LITERAL number (the source is authoritative; the
// editor never renumbers existing items), and todos show a clickable checkbox.
// Everything is CURSOR-AWARE: when the caret is on a line its
// raw markers reappear so you edit real text, exactly like reveal-to-edit for
// voids.
//
// All decorations here are line / mark / inline-replace (never block:true), so a
// ViewPlugin is legal and lets us scope the work to `view.visibleRanges` for
// performance. Void lines are skipped — their widgets come from a StateField
// (Phase 2); in Phase 1 they simply render as raw source.
//
// Ordering: decorations are collected into an array and handed to
// `Decoration.set(_, true)` (sorted) rather than a RangeSetBuilder, because a line
// and an inline replace can share an offset and hand-sorting is error-prone.

import {
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from "@codemirror/view";
import type { Range } from "@codemirror/state";
import { docModel } from "./doc-model";
import type { LineInfo } from "./blockmodel";

export const PLACEHOLDER = '输入文本，"/" 唤出命令';

/** Kind hints for empty TYPED blocks (old editor's KIND_HINTS): shown even
 *  unfocused, so an empty heading/quote reads as what it is. */
const KIND_HINTS: Record<string, string> = {
  h1: "标题 1",
  h2: "标题 2",
  h3: "标题 3",
  h4: "标题 4",
  h5: "标题 5",
  h6: "标题 6",
  quote: "引用",
};

/** Deepest nesting level with its own `.cm-nest-N` theme rule (editor-theme.ts). */
const MAX_NEST = 8;

class BulletWidget extends WidgetType {
  override eq() {
    return true;
  }
  override toDOM() {
    const s = document.createElement("span");
    s.className = "cm-bullet";
    s.textContent = "•";
    return s;
  }
  override ignoreEvent() {
    return false;
  }
}
const BULLET = new BulletWidget();

class HrWidget extends WidgetType {
  override eq() {
    return true;
  }
  override toDOM() {
    const s = document.createElement("span");
    s.className = "cm-hr";
    return s;
  }
}
const HR = new HrWidget();

class TodoWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly checkPos: number,
  ) {
    super();
  }
  override eq(other: TodoWidget) {
    return other.checked === this.checked && other.checkPos === this.checkPos;
  }
  override toDOM(view: EditorView) {
    // Wrapper spans the full marker column (its border-box is GUTTER-wide) so the
    // caret — which CM6 draws at the widget's border edge, IGNORING margins — lands
    // AFTER the trailing gap, not glued to the checkbox. The 16px box sits at its
    // left; the empty right of the wrapper is the checkbox→content gap.
    const wrap = document.createElement("span");
    wrap.className = "cm-todo";
    const box = document.createElement("span");
    box.className = "cm-todo-box" + (this.checked ? " checked" : "");
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
    // Toggle the `[ ]`/`[x]` character in the source with a single transaction.
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({
        changes: { from: this.checkPos, to: this.checkPos + 1, insert: this.checked ? " " : "x" },
        userEvent: "input",
      });
    });
    wrap.appendChild(box);
    return wrap;
  }
  override ignoreEvent() {
    return false;
  }
}

class OlNumWidget extends WidgetType {
  constructor(
    readonly num: number, // the LITERAL source number — display always equals source
    readonly sep: string, // the literal "." or ")" from the source marker
  ) {
    super();
  }
  override eq(other: OlNumWidget) {
    return other.num === this.num && other.sep === this.sep;
  }
  override toDOM() {
    const s = document.createElement("span");
    s.className = "cm-ol-num"; // same styling contract as the caret-on-line mark
    s.textContent = `${this.num}${this.sep} `;
    return s;
  }
  override ignoreEvent() {
    return false;
  }
}

/** Geometry lives in editor-theme.ts (`.cm-li` / `.cm-nested` + `--nest` from
 *  `.cm-nest-N`); this module only emits classes. `cm-nest-<level>` (cap MAX_NEST)
 *  selects the indent offset and, on list lines, the stacked indent guides. */
function nestCls(info: LineInfo): string {
  const n = Math.min(info.level, MAX_NEST);
  return n > 0 ? ` cm-nest-${n}` : "";
}

/** For an indented NON-list block line (nested under a list item), hide the literal
 *  leading whitespace and return its nesting classes so its content aligns under the
 *  parent item's content. Level 0 (indentChars 0) → "", a no-op, so top-level prose
 *  is untouched. */
function nestPad(info: LineInfo, out: Range<Decoration>[]): string {
  if (info.indentChars > 0) {
    out.push(Decoration.replace({}).range(info.from, info.from + info.indentChars));
    if (info.level > 0) return ` cm-nested${nestCls(info)}`;
  }
  return "";
}

/** Lines the selection touches — candidates for marker reveal. */
function activeLines(view: EditorView): Set<number> {
  const active = new Set<number>();
  for (const r of view.state.selection.ranges) {
    const a = view.state.doc.lineAt(r.from).number;
    const b = view.state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) active.add(n);
  }
  return active;
}

/** Does the selection intersect the MARKER REGION [from, contentFrom)? A collapsed
 *  caret exactly at contentFrom does NOT count — clicking into heading/quote text
 *  (including its very start) keeps the marker hidden and the line never shifts;
 *  only entering the marker region (e.g. Home, or ← past the boundary) reveals it. */
function inMarker(view: EditorView, info: LineInfo): boolean {
  if (info.contentFrom <= info.markerFrom) return false;
  return view.state.selection.ranges.some((r) => r.from < info.contentFrom && r.to >= info.from);
}

/** Line deco with a class plus optional data-ph placeholder attribute. */
function lineDeco(from: number, cls: string, ph?: string): Range<Decoration> {
  const spec: Parameters<typeof Decoration.line>[0] = { class: cls };
  if (ph !== undefined) {
    spec.class = `${cls} cm-ph-line`;
    spec.attributes = { "data-ph": ph };
  }
  return Decoration.line(spec).range(from);
}

function buildLine(
  view: EditorView,
  info: LineInfo,
  onLine: boolean,
  focused: boolean,
  sel0: boolean,
  out: Range<Decoration>[],
) {
  const role = info.role;
  if (role === "void") return; // Phase 2 widgets / Phase 1 raw source

  // Non-list block roles (heading / quote / divider / paragraph): when nested under
  // a list item (indented), hide the leading indent and pad so the child aligns with
  // its parent's content. Top-level (level 0) is unchanged.
  const isHeading = role.charCodeAt(0) === 104 /* 'h' */ && role.length === 2;
  if (isHeading || role === "quote") {
    // Reveal the marker only when the selection is IN the marker region — not
    // merely on the line — so clicking into the text never shifts it. Revealed
    // marker text renders muted (cm-md-mark), like inline delimiters.
    const revealed = focused && onLine && inMarker(view, info);
    // Kind hint (old KIND_HINTS): an empty typed block announces itself even
    // unfocused; suppressed while the raw marker is showing to avoid overlap.
    const empty = info.contentFrom === info.to;
    const hint = empty && !revealed ? KIND_HINTS[role] : undefined;
    out.push(lineDeco(info.from, isHeading ? `cm-h${role[1]}${nestPad(info, out)}` : `cm-quote${nestPad(info, out)}`, hint));
    if (info.contentFrom > info.markerFrom) {
      if (revealed) out.push(Decoration.mark({ class: "cm-md-mark" }).range(info.markerFrom, info.contentFrom));
      else out.push(Decoration.replace({}).range(info.markerFrom, info.contentFrom));
    }
    return;
  }

  if (role === "divider") {
    out.push(lineDeco(info.from, `cm-divider${nestPad(info, out)}`));
    if (!onLine && info.to > info.from)
      out.push(Decoration.replace({ widget: HR }).range(info.from, info.to));
    return;
  }

  if (role === "bullet" || role === "numbered" || role === "todo") {
    // Flush-left marker at the nesting level, content + wrapped rows at +26px
    // (hanging indent; pixel math + per-level indent guides live in
    // editor-theme.ts under .cm-li/.cm-nest-N). No base indent at level 0
    // (that was the "auto-indent" bug). Checked todos strike through (cm-li-done).
    const done = role === "todo" && !!info.checked;
    // Empty item hint (focused caret on the line only — idle empty items stay
    // blank, matching the old editor's subtle feel).
    const hint =
      focused && onLine && sel0 && info.contentFrom === info.to
        ? role === "todo"
          ? "待办"
          : "列表"
        : undefined;
    out.push(
      lineDeco(info.from, `cm-li cm-li-${role}${done ? " cm-li-done" : ""}${nestCls(info)}`, hint),
    );
    // Hide the literal leading whitespace (indent is shown via padding, not text).
    if (info.indentChars > 0) out.push(Decoration.replace({}).range(info.from, info.from + info.indentChars));

    if (role === "numbered") {
      // The number shows the LITERAL source value — literal numbers are
      // authoritative and the editor never renumbers existing items (new numbers
      // are generated only on creation: Enter continuation, slash, Tab, convert).
      // Display == source, so revealing can never flip a value. Reveal is
      // caret-driven and NARROW: only an empty caret inside the marker region
      // (Backspace/ArrowLeft past contentFrom) shows the raw text for editing;
      // drag-select/select-all keep the widget — the value is identical either
      // way, this just avoids style churn.
      if (info.contentFrom > info.markerFrom) {
        const sel = view.state.selection.main;
        const caretInMarker =
          focused && sel0 && sel.head >= info.markerFrom && sel.head < info.contentFrom;
        if (caretInMarker) {
          out.push(Decoration.mark({ class: "cm-md-mark" }).range(info.markerFrom, info.contentFrom));
        } else {
          const marker = info.text.slice(info.markerFrom - info.from, info.contentFrom - info.from);
          const sep = marker.includes(")") ? ")" : ".";
          out.push(
            Decoration.replace({
              widget: new OlNumWidget(info.num ?? 1, sep),
            }).range(info.markerFrom, info.contentFrom),
          );
        }
      }
    } else if (role === "bullet") {
      // Bullet glyph ALWAYS shows (even with the caret on the line) — it's a fixed
      // marker, not editable text; you edit content, Backspace at the start removes it.
      if (info.contentFrom > info.markerFrom)
        out.push(Decoration.replace({ widget: BULLET }).range(info.markerFrom, info.contentFrom));
    } else {
      // todo: the checkbox ALWAYS shows — the raw `- [ ] ` never becomes source while
      // you edit; Backspace at the content start removes it.
      if (info.contentFrom > info.markerFrom) {
        const bracket = info.text.indexOf("[", info.indentChars);
        const checkPos = bracket >= 0 ? info.from + bracket + 1 : info.markerFrom;
        out.push(
          Decoration.replace({ widget: new TodoWidget(!!info.checked, checkPos) }).range(
            info.markerFrom,
            info.contentFrom,
          ),
        );
      }
    }
    return;
  }

  if (role === "blank") {
    // Placeholder + slash hint only on the focused, collapsed caret line.
    if (focused && onLine && sel0)
      out.push(
        Decoration.line({ class: "cm-ph-line", attributes: { "data-ph": PLACEHOLDER } }).range(info.from),
      );
    return;
  }
  // role "p": inline marks are the inline plugin's job. Only a NESTED (indented)
  // paragraph — a continuation line under a list item — needs alignment; hide its
  // leading indent and class it to the parent's content column.
  const cls = nestPad(info, out);
  if (cls) out.push(lineDeco(info.from, cls.trimStart()));
}

function build(view: EditorView): DecorationSet {
  const model = docModel(view.state);
  const active = activeLines(view);
  const focused = view.hasFocus;
  const sel0 = view.state.selection.main.empty;
  const out: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const info = model.lines[line.number - 1];
      // Reveal a line's raw markers only when the editor is focused AND the caret
      // is on it; an unfocused document reads cleanly with every marker collapsed.
      if (info) buildLine(view, info, focused && active.has(line.number), focused, sel0, out);
      pos = line.to + 1;
    }
  }
  return Decoration.set(out, true);
}

export const blockDecorations = ViewPlugin.fromClass(
  class {
    deco: DecorationSet;
    constructor(view: EditorView) {
      this.deco = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || u.geometryChanged)
        this.deco = build(u.view);
    }
  },
  { decorations: (v) => v.deco },
);
