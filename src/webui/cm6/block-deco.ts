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
import { MAX_NEST, hiddenIndentChars, type LineInfo } from "./blockmodel";

export const PLACEHOLDER = '输入文本，"/" 唤出命令';

// Marker widgets carry a `sel` flag: native ::selection cannot paint replaced
// widgets, so a drag-select/select-all left unpainted holes in the marker
// column. When the selection covers the marker range the widget renders with
// .cm-mk-sel — the same accent tint styles.css gives the editor's ::selection.

class BulletWidget extends WidgetType {
  constructor(readonly sel: boolean) {
    super();
  }
  override eq(other: BulletWidget) {
    return other.sel === this.sel;
  }
  override toDOM() {
    const s = document.createElement("span");
    s.className = "cm-bullet" + (this.sel ? " cm-mk-sel" : "");
    s.textContent = "•";
    return s;
  }
  override ignoreEvent() {
    return false;
  }
}
const BULLET = new BulletWidget(false);
const BULLET_SEL = new BulletWidget(true);

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
    readonly sel: boolean,
  ) {
    super();
  }
  override eq(other: TodoWidget) {
    return other.checked === this.checked && other.checkPos === this.checkPos && other.sel === this.sel;
  }
  override toDOM(view: EditorView) {
    // Wrapper spans the full marker column (its border-box is GUTTER-wide) so the
    // caret — which CM6 draws at the widget's border edge, IGNORING margins — lands
    // AFTER the trailing gap, not glued to the checkbox. The 16px box sits at its
    // left; the empty right of the wrapper is the checkbox→content gap.
    const wrap = document.createElement("span");
    wrap.className = "cm-todo" + (this.sel ? " cm-mk-sel" : "");
    // A NATIVE checkbox, exactly like main's `.b-todo .marker input` — the OS
    // paints the box and the check, so the checked look matches the old editor
    // pixel-for-pixel (a hand-drawn span was rejected as a visual regression).
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-todo-box";
    box.checked = this.checked;
    box.tabIndex = -1;
    // Toggle the `[ ]`/`[x]` character in the source with a single transaction;
    // the doc change rebuilds this widget, so the input itself must never toggle
    // (click is prevented — the document is the single source of truth).
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({
        changes: { from: this.checkPos, to: this.checkPos + 1, insert: this.checked ? " " : "x" },
        userEvent: "input",
      });
    });
    box.addEventListener("click", (e) => e.preventDefault());
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
    readonly sel: boolean,
  ) {
    super();
  }
  override eq(other: OlNumWidget) {
    return other.num === this.num && other.sep === this.sep && other.sel === this.sel;
  }
  override toDOM() {
    const s = document.createElement("span");
    s.className = "cm-ol-num" + (this.sel ? " cm-mk-sel" : ""); // same styling contract as the caret-on-line mark
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

/** For ANY indented non-list block line (heading/quote/divider/paragraph), hide
 *  the leading whitespace that makes up FULL 2-column nesting levels and return
 *  the alignment classes: every indented line sits on the 24px column grid. Two
 *  source spaces = one visual level — the markdown source stays authoritative,
 *  and the dashed indent guides (editor-theme.ts) make the snap legible. An odd
 *  remainder space (level math floors) or indentation beyond MAX_NEST is NOT
 *  hidden: it stays visible as literal text. */
function nestPad(info: LineInfo, out: Range<Decoration>[]): string {
  if (info.indentChars > 0) {
    const hide = hiddenIndentChars(info);
    if (hide > 0) out.push(Decoration.replace({}).range(info.from, info.from + hide));
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

/** Is an EMPTY caret inside the MARKER REGION [from, contentFrom)? A caret exactly
 *  at contentFrom does NOT count — clicking into heading/quote text (including its
 *  very start) keeps the marker hidden and the line never shifts; only entering the
 *  marker region (Home, or ← past the boundary) reveals it. Range selections never
 *  reveal (mirrors the numbered-marker rule): drag-select/select-all must not make
 *  lines jump, and the marker is not text you can partially select anyway. */
function inMarker(view: EditorView, info: LineInfo): boolean {
  if (info.contentFrom <= info.markerFrom) return false;
  const sel = view.state.selection.main;
  return sel.empty && sel.head >= info.from && sel.head < info.contentFrom;
}

/** Does a NON-EMPTY selection range cover the whole marker region? Drives the
 *  .cm-mk-sel paint on marker widgets — native ::selection can't reach replaced
 *  content, which left holes in the marker column during drag-select/select-all. */
function markerCovered(view: EditorView, info: LineInfo): boolean {
  return view.state.selection.ranges.some(
    (r) => !r.empty && r.from <= info.markerFrom && r.to >= info.contentFrom,
  );
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

  // Non-list block roles (heading / quote / divider / paragraph): any indented
  // line has its full-level leading indent hidden and pads onto the 24px column
  // grid (nestPad); top-level (level 0) is unchanged.
  const isHeading = role.charCodeAt(0) === 104 /* 'h' */ && role.length === 2;
  if (isHeading || role === "quote") {
    // Reveal the marker only when the selection is IN the marker region — not
    // merely on the line — so clicking into the text never shifts it. Revealed
    // marker text renders muted (cm-md-mark), like inline delimiters.
    const revealed = focused && onLine && inMarker(view, info);
    // Unified placeholder: shown only with the focused caret on the empty line
    // (the old "announces itself even unfocused" kind-hint rule is deliberately
    // gone); still suppressed while the raw marker shows to avoid overlap.
    const empty = info.contentFrom === info.to;
    const hint = focused && onLine && sel0 && empty && !revealed ? PLACEHOLDER : undefined;
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
    // blank, matching the old editor's subtle feel). Same unified PLACEHOLDER
    // as every other empty block.
    const hint =
      focused && onLine && sel0 && info.contentFrom === info.to ? PLACEHOLDER : undefined;
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
              widget: new OlNumWidget(info.num ?? 1, sep, markerCovered(view, info)),
            }).range(info.markerFrom, info.contentFrom),
          );
        }
      }
    } else if (role === "bullet") {
      // Bullet glyph ALWAYS shows (even with the caret on the line) — it's a fixed
      // marker, not editable text; you edit content, Backspace at the start removes it.
      if (info.contentFrom > info.markerFrom)
        out.push(
          Decoration.replace({ widget: markerCovered(view, info) ? BULLET_SEL : BULLET }).range(
            info.markerFrom,
            info.contentFrom,
          ),
        );
    } else {
      // todo: the checkbox ALWAYS shows — the raw `- [ ] ` never becomes source while
      // you edit; Backspace at the content start removes it.
      if (info.contentFrom > info.markerFrom) {
        const bracket = info.text.indexOf("[", info.indentChars);
        const checkPos = bracket >= 0 ? info.from + bracket + 1 : info.markerFrom;
        out.push(
          Decoration.replace({
            widget: new TodoWidget(!!info.checked, checkPos, markerCovered(view, info)),
          }).range(info.markerFrom, info.contentFrom),
        );
      }
    }
    return;
  }

  if (role === "blank") {
    // Indented blank line: sits on the 24px column grid like every other
    // indented line (hidden indent + guides via cm-nested/cm-nest-N) and NEVER
    // shows a placeholder — the hint belongs to level-0 empty lines only.
    if (info.indentChars > 0) {
      const cls = nestPad(info, out);
      if (cls) out.push(lineDeco(info.from, cls.trimStart()));
      return;
    }
    // Level-0 blank: placeholder + slash hint only on the focused, collapsed
    // caret line.
    if (focused && onLine && sel0) {
      out.push(Decoration.line({ class: "cm-ph-line", attributes: { "data-ph": PLACEHOLDER } }).range(info.from));
    }
    return;
  }
  // role "p": inline marks are the inline plugin's job. An indented paragraph
  // snaps onto the 24px column grid; hide its full-level leading indent and
  // class it to the matching nest column.
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
      if (info) {
        buildLine(view, info, focused && active.has(line.number), focused, sel0, out);
      }
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
