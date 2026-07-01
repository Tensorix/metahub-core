// Block-level line decorations for the single-document editor.
//
// This ViewPlugin turns each visible line's derived role (blockmodel.ts) into the
// WYSIWYG presentation of a Notion-style block WITHOUT ever leaving the source
// model: headings get a size class and their `# ` collapses, quotes get a rule and
// their `> ` collapses, dividers render as a horizontal rule, list lines get their
// leading whitespace hidden + a per-level padding indent, bullets show a glyph,
// ordered numbers stay as literal editable text (just styled), and todos show a
// clickable checkbox. Everything is CURSOR-AWARE: when the caret is on a line its
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

/** Visual indent per list nesting level, in px. */
const INDENT_STEP = 24;

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
    return box;
  }
  override ignoreEvent() {
    return false;
  }
}

/** Marker-column width for list lines (hanging-indent gutter). All three markers —
 *  the bullet glyph, the checkbox, and the ordered `N. ` — sit in a 24px CENTERED
 *  column (matching main's `.marker{width:24px;text-align:center}`) so their content
 *  left-edges align and the marker→content gap is uniform and tight. */
const GUTTER = 24;

/** For an indented NON-list block line (nested under a list item), hide the literal
 *  leading whitespace and return the px to indent it so its content aligns under the
 *  parent item's content. Level 0 (indentChars 0) → 0, a no-op, so top-level prose is
 *  untouched. */
function nestPad(info: LineInfo, out: Range<Decoration>[]): number {
  if (info.indentChars > 0) {
    out.push(Decoration.replace({}).range(info.from, info.from + info.indentChars));
    return INDENT_STEP * info.level;
  }
  return 0;
}

/** A `Decoration.line` carrying an optional class and an optional padding-left. */
function lineDeco(from: number, cls: string | undefined, pad: number): Range<Decoration> {
  const spec: Parameters<typeof Decoration.line>[0] = {};
  if (cls) spec.class = cls;
  if (pad > 0) spec.attributes = { style: `padding-left:${pad}px` };
  return Decoration.line(spec).range(from);
}

/** Lines the selection touches — their markers reveal (show raw source). */
function activeLines(view: EditorView): Set<number> {
  const active = new Set<number>();
  for (const r of view.state.selection.ranges) {
    const a = view.state.doc.lineAt(r.from).number;
    const b = view.state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) active.add(n);
  }
  return active;
}

function buildLine(info: LineInfo, onLine: boolean, focused: boolean, sel0: boolean, out: Range<Decoration>[]) {
  const role = info.role;
  if (role === "void") return; // Phase 2 widgets / Phase 1 raw source

  // Non-list block roles (heading / quote / divider / paragraph): when nested under
  // a list item (indented), hide the leading indent and pad so the child aligns with
  // its parent's content. Top-level (level 0) is unchanged.
  if (role.charCodeAt(0) === 104 /* 'h' */ && role.length === 2) {
    out.push(lineDeco(info.from, `cm-h${role[1]}`, nestPad(info, out)));
    if (!onLine && info.contentFrom > info.markerFrom)
      out.push(Decoration.replace({}).range(info.markerFrom, info.contentFrom));
    return;
  }

  if (role === "quote") {
    out.push(lineDeco(info.from, "cm-quote", nestPad(info, out)));
    if (!onLine && info.contentFrom > info.markerFrom)
      out.push(Decoration.replace({}).range(info.markerFrom, info.contentFrom));
    return;
  }

  if (role === "divider") {
    out.push(lineDeco(info.from, "cm-divider", nestPad(info, out)));
    if (!onLine && info.to > info.from)
      out.push(Decoration.replace({ widget: HR }).range(info.from, info.to));
    return;
  }

  if (role === "bullet" || role === "numbered" || role === "todo") {
    // Flush-left marker at the nesting level, content + wrapped rows at +GUTTER
    // (hanging indent). No base indent at level 0 (that was the "auto-indent" bug).
    const nest = INDENT_STEP * info.level;
    let style = `padding-left:${nest + GUTTER}px;text-indent:-${GUTTER}px`;
    // Nested items get one subtle vertical guide per ancestor level (matching main's
    // `.block-wrap.nested::before`), painted as stacked 1px background gradients that
    // butt against adjacent rows into a continuous line. Guides sit ~11px into each
    // indent step, i.e. under the parent marker.
    if (info.level > 0) {
      const imgs: string[] = [];
      const sizes: string[] = [];
      const positions: string[] = [];
      for (let k = 0; k < info.level; k++) {
        imgs.push("linear-gradient(var(--line),var(--line))");
        sizes.push("1px 100%");
        positions.push(`${INDENT_STEP * k + 11}px 0`);
      }
      style += `;background-image:${imgs.join(",")};background-size:${sizes.join(",")};background-position:${positions.join(",")};background-repeat:no-repeat`;
    }
    out.push(
      Decoration.line({
        class: `cm-li cm-li-${role}`,
        attributes: { style },
      }).range(info.from),
    );
    // Hide the literal leading whitespace (indent is shown via padding, not text).
    if (info.indentChars > 0) out.push(Decoration.replace({}).range(info.from, info.from + info.indentChars));

    if (role === "numbered") {
      // Just style the literal "N. " — the source number is kept correct by the
      // renumber transaction filter, so display always equals the literal.
      out.push(Decoration.mark({ class: "cm-ol-num" }).range(info.markerFrom, info.contentFrom));
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
  // leading indent and pad it to the parent's content column.
  const pad = nestPad(info, out);
  if (pad > 0) out.push(lineDeco(info.from, undefined, pad));
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
      if (info) buildLine(info, focused && active.has(line.number), focused, sel0, out);
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
