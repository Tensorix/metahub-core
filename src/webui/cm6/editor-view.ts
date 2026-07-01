// Extension assembly for the single-document editor.
//
// Puts the derived-model field, the cursor-aware decoration plugins, and the
// structure keymap behind a Compartment so "source mode" can drop them (leaving a
// plain Markdown text editor) without rebuilding the view. drawSelection +
// dropCursor are required — the native contentEditable caret disappears amid block
// decorations. history() gives native undo/redo (all structure ops are ordinary
// text transactions, so it covers everything the old custom Snap did).

import { EditorView, drawSelection, dropCursor, keymap } from "@codemirror/view";
import { Compartment, type Extension } from "@codemirror/state";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { docModelField, docModel } from "./doc-model";
import { voidField } from "./voids/void-field";
import { blockDecorations } from "./block-deco";
import { inlineDecorations } from "./inline";
import { structureKeymap } from "./keymap";
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
  const isList = line.role === "bullet" || line.role === "numbered" || line.role === "todo";
  if (!isList || from < line.contentFrom) return false;
  const before = view.state.sliceDoc(line.contentFrom, from);
  const sc = shortcutFromInput(before + " ", " ");
  if (!sc || (sc.type !== "quote" && !isHeadingType(sc.type))) return false;
  const childIndent = " ".repeat(line.indentChars + 2); // one nesting level = 2 spaces
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

export interface EditorOpts {
  /** ArrowUp on the first visual row hands focus to the title. */
  onExitTop?: () => void;
}

/** The WYSIWYG layer that "source mode" removes: void widgets, decorations, and
 *  the structure keymap. The derived model (docModelField) is NOT here — it stays
 *  always-on (baseExtensions) so chrome keeps working in source mode. voidField
 *  before the decoration plugins so block widgets win at shared offsets. */
export function richLayer(opts: EditorOpts): Extension {
  return [
    voidField,
    blockDecorations,
    inlineDecorations,
    EditorView.inputHandler.of(nestShortcut),
    structureKeymap(opts),
  ];
}

/** The always-on baseline plus the toggleable rich layer. Callers append their own
 *  chrome, updateListener (save), and initial doc. */
export function baseExtensions(opts: EditorOpts): Extension[] {
  return [
    docModelField, // always on — chrome + voidField read it, even in source mode
    history(),
    drawSelection(),
    dropCursor(),
    EditorView.lineWrapping,
    editorTheme,
    richCompartment.of(richLayer(opts)),
    // Structure keymap (inside the compartment) is Prec.highest and runs first;
    // these are the fall-through defaults for ordinary editing + undo/redo.
    keymap.of([...defaultKeymap, ...historyKeymap]),
  ];
}
