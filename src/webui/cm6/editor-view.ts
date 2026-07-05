// Extension assembly for the single-document editor.
//
// Puts the derived-model field, the cursor-aware decoration plugins, and the
// structure keymap behind a Compartment so "source mode" can drop them (leaving a
// plain Markdown text editor) without rebuilding the view. Native selection/caret
// (no drawSelection): they follow color-scheme automatically in dark mode and add
// no compositing layers; runtime-verified that the native caret stays visible on
// decorated lines (list markers, headings, lines adjacent to void widgets).
// history() gives native undo/redo (all structure ops are ordinary text
// transactions, so it covers everything the old custom Snap did).

import { EditorView, dropCursor, keymap } from "@codemirror/view";
import { Compartment, type Extension } from "@codemirror/state";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { docModelField, docModel } from "./doc-model";
import { isListRole } from "./blockmodel";
import { voidField, clampVoidSelection } from "./voids/void-field";
import { blockDecorations } from "./block-deco";
import { inlineDecorations } from "./inline";
import { structureKeymap } from "./keymap";
import { markerAtomsField } from "./marker-atoms";
import { editorTheme } from "./editor-theme";
import { shortcutFromInput, isHeadingType } from "../blocks";

/** Nest-on-type: inside a list item, typing a quote/heading marker + space ("> ",
 *  "## ") moves that marker onto an indented child line, so the block nests under
 *  the item (the flat scanner then renders it aligned). At top level the marker
 *  becomes a block on its own via the scanner, so this only handles the in-list
 *  case where the list marker would otherwise swallow it. Lists sub-nest via Tab;
 *  code/table are handled elsewhere. */
function nestShortcut(view: EditorView, from: number, to: number, insert: string): boolean {
  if (insert !== " " || from !== to || view.composing) return false;
  const line = docModel(view.state).lines[view.state.doc.lineAt(from).number - 1];
  if (!line) return false;
  const isList = isListRole(line.role);
  if (!isList || from < line.contentFrom) return false;
  const before = view.state.sliceDoc(line.contentFrom, from);
  const sc = shortcutFromInput(before + " ", " ");
  if (!sc || (sc.type !== "quote" && !isHeadingType(sc.type))) return false;
  // COLUMNS, not chars (a tab counts 4 columns): same rule as fenceContinuation,
  // otherwise a tab-indented item nests its child SHALLOWER than itself.
  const childIndent = " ".repeat(line.indent + 2);
  const marker = before + " ";
  const rest = view.state.sliceDoc(from, line.to);
  view.dispatch({
    changes: { from: line.contentFrom, to: line.to, insert: "\n" + childIndent + marker + rest },
    selection: { anchor: line.contentFrom + 1 + childIndent.length + marker.length },
    userEvent: "input",
    scrollIntoView: true,
  });
  return true;
}

/** Toggles the rich WYSIWYG layer (decorations + structure keys) on/off; off =
 *  source mode (plain Markdown). */
export const richCompartment = new Compartment();

/** Pixels of viewport top the fixed .topbar covers, plus breathing room — CM must
 *  scroll targets below it (TOC jumps, find matches, typing near the top). Replaces
 *  the old `.block { scroll-margin-top:60px }`.
 *
 *  CACHED: CM consults scrollMargins during every measure cycle (each scrolled
 *  frame), and a document-wide querySelector + getBoundingClientRect per frame
 *  is pure waste for a value that only changes with layout. The cache
 *  invalidates on window resize / orientation change (what actually moves the
 *  responsive topbar height + safe-area insets) and re-resolves the element
 *  lazily so late-mounted topbars are picked up. */
let topbarCache = -1;
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const invalidate = () => { topbarCache = -1; };
  window.addEventListener("resize", invalidate);
  window.addEventListener("orientationchange", invalidate);
}
function topbarClearance(): number {
  if (typeof document === "undefined") return 60;
  if (topbarCache < 0) {
    topbarCache = (document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 52) + 8;
  }
  return topbarCache;
}

export interface EditorOpts {
  /** ArrowUp on the first visual row hands focus to the title. */
  onExitTop?: () => void;
}

/** The WYSIWYG layer that "source mode" removes: void widgets, decorations, and
 *  the structure keymap. The derived model (docModelField) is NOT here — it stays
 *  always-on (baseExtensions) so chrome keeps working in source mode. voidField
 *  before the decoration plugins so block widgets win at shared offsets. */
/** Todo shortcut: in a bullet item whose content-so-far is `[]` / `[ ]` / `[x]`,
 *  typing the space turns the line into a canonical todo (`- [ ] ` / `- [x] `). The
 *  scanner already recognizes `- [ ] `/`- [x] `, so this mainly rescues the empty
 *  `[]` the user types. */
function todoShortcut(view: EditorView, from: number, to: number, insert: string): boolean {
  if (insert !== " " || from !== to || view.composing) return false;
  const line = docModel(view.state).lines[view.state.doc.lineAt(from).number - 1];
  if (!line || line.role !== "bullet" || from < line.contentFrom) return false;
  const m = view.state.sliceDoc(line.contentFrom, from).match(/^\[([ xX]?)\]$/);
  if (!m) return false;
  const glyph = line.text[line.indentChars] ?? "-";
  const indent = line.text.slice(0, line.indentChars);
  const marker = `${indent}${glyph} [${m[1]!.toLowerCase() === "x" ? "x" : " "}] `;
  const rest = view.state.sliceDoc(from, line.to);
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: marker + rest },
    selection: { anchor: line.from + marker.length },
    userEvent: "input",
    scrollIntoView: true,
  });
  return true;
}

export function richLayer(opts: EditorOpts): Extension {
  return [
    voidField,
    clampVoidSelection, // dispatched selections must respect atomic voids too
    blockDecorations,
    inlineDecorations,
    EditorView.inputHandler.of(todoShortcut),
    EditorView.inputHandler.of(nestShortcut),
    // Constant markers (bullet glyph, todo checkbox) are atomic — the caret
    // skips their hidden text. Numbered markers are NOT: the ordinal is
    // ordinary editable text (literal numbers are authoritative).
    markerAtomsField,
    structureKeymap(opts),
  ];
}

/** The always-on baseline plus the toggleable rich layer. Callers append their own
 *  chrome, updateListener (save), and initial doc. */
export function baseExtensions(opts: EditorOpts): Extension[] {
  return [
    docModelField, // always on — chrome + voidField read it, even in source mode
    history(),
    dropCursor(),
    EditorView.lineWrapping,
    // CM6's contentDOM defaults disable the browser's text niceties
    // (spellcheck="false", autocorrect/autocapitalize "off") — right for source
    // code, wrong for a prose editor. The old contentEditable blocks had them
    // all on by default; restore them (desktop red squiggles, iOS autocorrect
    // and sentence capitalization).
    EditorView.contentAttributes.of({
      spellcheck: "true",
      autocorrect: "on",
      autocapitalize: "sentences",
    }),
    EditorView.scrollMargins.of(() => ({ top: topbarClearance(), bottom: 8 })),
    editorTheme,
    richCompartment.of(richLayer(opts)),
    // Structure keymap (inside the compartment) is Prec.highest and runs first;
    // these are the fall-through defaults for ordinary editing + undo/redo.
    keymap.of([...defaultKeymap, ...historyKeymap]),
  ];
}
