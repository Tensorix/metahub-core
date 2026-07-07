// Block/line-range helpers shared by the hover gutter and the structure keymap.
//
// A "block" is a single line, or the whole line-span of a void (fenced code,
// table, media). These helpers resolve line numbers to block ranges, expand a
// selection to whole lines, and duplicate a range — all as plain text
// transactions so native undo covers them.

import type { EditorView } from "@codemirror/view";
import { docModel } from "./doc-model";
import { isListRole, quoteRunAt } from "./blockmodel";

export interface BlockRange {
  fromLine: number;
  toLine: number;
  from: number;
  to: number;
}

/** The line span of the block at 1-based line `n`. Multi-line blocks answer with
 *  their whole span: a void with all its source lines, a quote with its whole
 *  contiguous same-level run — so Mod-a/Mod-d/gutter and Tab stepping agree on
 *  what "the block" is. */
export function blockAt(view: EditorView, n: number): BlockRange {
  const model = docModel(view.state);
  const v = model.voids.find((v) => n >= v.fromLine && n <= v.toLine);
  const doc = view.state.doc;
  if (v) return { fromLine: v.fromLine, toLine: v.toLine, from: doc.line(v.fromLine).from, to: doc.line(v.toLine).to };
  if (model.lines[n - 1]?.role === "quote") {
    const run = quoteRunAt(model.lines, n);
    return { fromLine: run.fromLine, toLine: run.toLine, from: doc.line(run.fromLine).from, to: doc.line(run.toLine).to };
  }
  const line = doc.line(n);
  return { fromLine: n, toLine: n, from: line.from, to: line.to };
}

/** The 1-based line span covered by the main selection, or null when it's empty.
 *  A selection ending exactly at a line start doesn't count that line (the usual
 *  triple-click / drag-past-newline shape). */
export function rangeForSelection(view: EditorView): { fromLine: number; toLine: number } | null {
  const sel = view.state.selection.main;
  if (sel.empty) return null;
  const doc = view.state.doc;
  const fromLine = doc.lineAt(sel.from).number;
  let toLine = doc.lineAt(sel.to).number;
  if (toLine > fromLine && sel.to === doc.line(toLine).from) toLine--;
  return { fromLine, toLine };
}

/** Expand a line span to whole blocks (both endpoints snapped to void
 *  boundaries) with document offsets. */
export function lineSpanRange(view: EditorView, fromLine: number, toLine: number): BlockRange {
  const a = blockAt(view, fromLine);
  const b = blockAt(view, Math.max(fromLine, toLine));
  return { fromLine: a.fromLine, toLine: b.toLine, from: a.from, to: b.to };
}

/** Insert a copy of the range's text right below it (one transaction). */
export function duplicateRange(view: EditorView, range: { from: number; to: number }): void {
  const text = view.state.sliceDoc(range.from, range.to);
  view.dispatch({ changes: { from: range.to, insert: "\n" + text }, userEvent: "input.duplicate" });
}

/** Mod-d command: duplicate the block at the caret, or the selection's whole
 *  line range when the selection is non-empty. */
export function duplicateBlock(view: EditorView): boolean {
  const sel = rangeForSelection(view);
  const range = sel
    ? lineSpanRange(view, sel.fromLine, sel.toLine)
    : blockAt(view, view.state.doc.lineAt(view.state.selection.main.head).number);
  duplicateRange(view, range);
  return true;
}

/** The block at the caret extended to its subtree: for a list item, following
 *  lines with deeper indentation (its children in the flat model); blanks between
 *  them are transparent but a trailing blank is not included. Used by Mod-a
 *  staged select AND by the gutter's move/duplicate/delete — a parent list item
 *  travels with its children (the old editor's block-tree semantics). */
export function blockSpanWithChildren(view: EditorView, n: number): BlockRange {
  const base = blockAt(view, n);
  const lines = docModel(view.state).lines;
  const info = lines[base.fromLine - 1];
  if (!info || !isListRole(info.role)) return base;
  let toLine = base.toLine;
  for (let i = base.toLine; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.role === "blank") continue; // transparent, only kept if a deeper line follows
    if (l.indent > info.indent) { toLine = l.number; continue; }
    break;
  }
  if (toLine === base.toLine) return base;
  return lineSpanRange(view, base.fromLine, toLine);
}

/** Mod-a command: staged select-all — first press selects the caret's block
 *  (a list item includes its indented subtree; a void its whole span), second
 *  press (selection already covers that span) widens to the whole document.
 *  Mirrors the old editor's two-stage Ctrl+A. */
export function selectStaged(view: EditorView): boolean {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const span = blockSpanWithChildren(view, doc.lineAt(sel.head).number);
  const coversSpan = sel.from <= span.from && sel.to >= span.to;
  const target = coversSpan ? { anchor: 0, head: doc.length } : { anchor: span.from, head: span.to };
  if (sel.from === target.anchor && sel.to === target.head) return true; // already all
  view.dispatch({ selection: target, userEvent: "select" });
  return true;
}
