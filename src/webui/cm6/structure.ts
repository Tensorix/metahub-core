// Structure editing as pure text transactions.
//
// In the single-document model every structural action — continuing a list on
// Enter, deleting a marker on Backspace, indenting on Tab — is an ordinary edit of
// the one Markdown document. There is no block tree to mutate and no focus to
// hand off: the line grammar re-derives the block model on the next change, and
// native CM6 history covers undo. Each function here is a CM6 `Command`
// ((view) => boolean): it either performs a dispatch and returns true, or returns
// false to let the default keymap handle the key.
//
// Line roles/offsets come from `docModel(state)` (blockmodel.ts), so behavior can
// never drift from what the scanner — and therefore a save/reload — produces.

import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { docModel } from "./doc-model";
import type { LineInfo, DocModel } from "./blockmodel";
import { RE } from "../blocks";

/** The scanned model line covering `pos` (line numbers are 1-based and dense). */
function lineAt(view: EditorView, pos: number): LineInfo {
  const n = view.state.doc.lineAt(pos).number;
  return docModel(view.state).lines[n - 1]!;
}

/** Leading whitespace of a line (the exact indent chars, for continuations). */
function indentPrefix(line: LineInfo): string {
  return line.text.slice(0, line.indentChars);
}

/** The marker to write for the NEXT item continuing this list line. Numbered
 *  advances by one from the literal number (no global renumber — lesson: source
 *  numbers may be non-contiguous, like Obsidian). Bullet/todo keep the leading
 *  glyph the user used. */
function nextMarker(line: LineInfo): string {
  const glyph = line.text[line.indentChars] ?? "-";
  if (line.role === "numbered") return `${(line.num ?? 1) + 1}. `;
  if (line.role === "todo") return `${glyph} [ ] `;
  return `${glyph} `;
}

/** The correct ordered number for a line placed at `newLevel`: continue the previous
 *  sibling's run there (+1), or 1 if it's the first item at that level (a shallower
 *  ancestor or a non-numbered sibling precedes it). Blank lines are transparent.
 *  Used only at the discrete Tab/Shift-Tab moment — never a global renumber. */
function correctNumberAtLevel(model: DocModel, lineNumber: number, newLevel: number): number {
  for (let i = lineNumber - 2; i >= 0; i--) {
    const li = model.lines[i];
    if (!li || li.role === "blank") continue;
    if (li.level > newLevel) continue; // deeper sub-list — skip over it
    if (li.level < newLevel) return 1; // reached an ancestor → first child at newLevel
    return li.role === "numbered" ? (li.num ?? 0) + 1 : 1; // same level: continue run or break
  }
  return 1;
}

/** Enter: continue a list/quote, exit an empty item, split at the caret; else let
 *  the default (newline, incl. code-void auto-indent) run. */
export function enterCommand(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false; // typing over a selection → default replace+newline
  const line = lineAt(view, sel.head);

  // Unclosed opening code fence + Enter → complete the block: insert the matching
  // closing fence with an empty middle line and land the caret on it. The scanner
  // then sees a paired fence (a code void), and the caret being inside reveals the
  // raw source so the user types code immediately. The opener line (incl. a
  // ```lang info string) is left verbatim.
  if (line.role === "p" && sel.head === line.to) {
    const m = line.text.match(RE.fenceOpen);
    if (m) {
      const indent = line.text.slice(0, line.indentChars);
      const close = m[1]![0]!.repeat(m[1]!.length); // same char (` or ~), same length
      view.dispatch({
        changes: { from: line.to, insert: `\n${indent}\n${indent}${close}` },
        selection: { anchor: line.to + 1 + indent.length },
        userEvent: "input",
        scrollIntoView: true,
      });
      return true;
    }
  }

  // Revealed code/html source, or plain prose: let CM insert the newline. For code
  // the default keeps indentation, which is what you want inside a fence.
  if (line.role === "void" || line.role === "p" || line.role === "blank" || line.role.startsWith("h") || line.role === "divider")
    return false;

  const isList = line.role === "bullet" || line.role === "numbered" || line.role === "todo";
  const isQuote = line.role === "quote";
  if (!isList && !isQuote) return false;

  const empty = line.contentFrom >= line.to; // nothing after the marker
  if (empty) {
    // Enter on an empty item exits the construct: strip indent + marker, leaving a
    // blank paragraph in place (caret stays on the now-empty line).
    view.dispatch({
      changes: { from: line.from, to: line.contentFrom, insert: "" },
      selection: { anchor: line.from },
      userEvent: "input",
      scrollIntoView: true,
    });
    return true;
  }

  const marker = isQuote ? `${indentPrefix(line)}> ` : indentPrefix(line) + nextMarker(line);
  const insert = "\n" + marker;
  view.dispatch({
    changes: { from: sel.head, insert },
    selection: { anchor: sel.head + insert.length },
    userEvent: "input",
    scrollIntoView: true,
  });
  return true;
}

/** Backspace: at the caret-after-marker position, strip the marker (→ paragraph);
 *  otherwise let the default character/line delete run. */
export function backspaceCommand(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = lineAt(view, sel.head);

  // Caret sits right after a block marker (`# `, `- `, `1. `, `- [ ] `, `> `) →
  // remove indent + marker so the line becomes a plain paragraph. Only when there
  // actually IS a marker (contentFrom past the line start).
  const marked =
    line.role === "bullet" ||
    line.role === "numbered" ||
    line.role === "todo" ||
    line.role === "quote" ||
    line.role.startsWith("h");
  if (marked && sel.head === line.contentFrom && line.contentFrom > line.from) {
    view.dispatch({
      changes: { from: line.from, to: line.contentFrom, insert: "" },
      selection: { anchor: line.from },
      userEvent: "delete",
    });
    return true;
  }

  // Backspace at the very start of the line right after a void (table/media/code)
  // selects the whole void — the affordance to delete/move an atomic block the caret
  // can't enter. A second Backspace then deletes the selection (default).
  if (sel.head === line.from && line.number > 1) {
    const v = docModel(view.state).voids.find((v) => v.to === line.from - 1);
    if (v) {
      view.dispatch({ selection: EditorSelection.range(v.from, v.to) });
      return true;
    }
  }
  return false; // default deleteCharBackward (incl. merge with previous line)
}

/** Indent (delta = +1) or outdent (delta = -1) every line the selection covers, by
 *  two spaces. With an empty selection on a non-list, non-void indent inserts two
 *  spaces at the caret instead (so Tab never leaks focus out of the editor). */
function reindent(view: EditorView, delta: 1 | -1): boolean {
  const { state } = view;
  const ranges = state.selection.ranges;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();

  const single = state.selection.main.empty && ranges.length === 1;
  const caretLine = lineAt(view, state.selection.main.head);
  const caretIsList =
    caretLine.role === "bullet" || caretLine.role === "numbered" || caretLine.role === "todo";

  // Empty selection on a non-list line: Tab inserts spaces at the caret (code
  // indent / plain paragraph), rather than shifting the whole line.
  if (delta > 0 && single && !caretIsList && caretLine.role !== "quote") {
    view.dispatch(state.replaceSelection("  "));
    return true;
  }

  // Re-leveling a single ordered item is the one moment we (re)generate its number:
  // set it to the correct value for its NEW nesting level, in the same transaction.
  // Only this moved item is touched — siblings / user-set / out-of-order numbers are
  // left alone (no global renumber).
  if (single && caretLine.role === "numbered") {
    const line = caretLine;
    const newIndentChars = delta > 0 ? line.indentChars + 2 : Math.max(0, line.indentChars - 2);
    if (newIndentChars === line.indentChars) return true; // already flush-left, can't outdent
    const newLevel = Math.floor(newIndentChars / 2);
    const num = correctNumberAtLevel(docModel(state), line.number, newLevel);
    const oldMarker = line.text.slice(line.indentChars, line.contentFrom - line.from); // "3. " / "3) "
    const tail = oldMarker.slice(line.numChars ?? String(line.num ?? 1).length); // ". " / ") "
    const prefix = " ".repeat(newIndentChars) + num + tail;
    const head = state.selection.main.head;
    const newHead =
      head >= line.contentFrom ? head + (prefix.length - (line.contentFrom - line.from)) : line.from + prefix.length;
    view.dispatch({
      changes: { from: line.from, to: line.contentFrom, insert: prefix },
      selection: { anchor: newHead },
      userEvent: delta > 0 ? "input.indent" : "delete.dedent",
      scrollIntoView: true,
    });
    return true;
  }

  for (const r of ranges) {
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      if (delta > 0) {
        changes.push({ from: line.from, insert: "  " });
      } else {
        const strip = /^ {1,2}/.exec(line.text);
        if (strip) changes.push({ from: line.from, to: line.from + strip[0].length, insert: "" });
      }
    }
  }
  if (!changes.length) return true; // nothing to outdent, but consume the key
  view.dispatch({ changes, userEvent: delta > 0 ? "input.indent" : "delete.dedent" });
  return true;
}

export function indentCommand(view: EditorView): boolean {
  return reindent(view, 1);
}
export function outdentCommand(view: EditorView): boolean {
  return reindent(view, -1);
}

/** Smart Home: jump to the content start (after the marker); if already there,
 *  toggle to the true line start. Collapses the selection. */
export function smartHome(view: EditorView): boolean {
  const model = docModel(view.state);
  const sel = view.state.selection;
  const next = EditorSelection.create(
    sel.ranges.map((r) => {
      const n = view.state.doc.lineAt(r.head).number;
      const line = model.lines[n - 1]!;
      const target = r.head === line.contentFrom ? line.from : line.contentFrom;
      return EditorSelection.cursor(target);
    }),
    sel.mainIndex,
  );
  view.dispatch({ selection: next, userEvent: "select" });
  return true;
}

/** ArrowUp on the first visual row of the document → hand off to the title. Uses
 *  live coords (allowed here: keymap commands run outside the update/measure
 *  cycle). */
export function makeExitTop(onExitTop?: () => void) {
  return function exitTop(view: EditorView): boolean {
    if (!onExitTop) return false;
    const sel = view.state.selection.main;
    if (!sel.empty) return false;
    const first = view.state.doc.line(1);
    if (sel.head > first.to) return false; // not on the first document line
    const head = view.coordsAtPos(sel.head);
    const top = view.coordsAtPos(first.from);
    if (head && top && head.top <= top.top + 1) {
      onExitTop();
      return true;
    }
    return false;
  };
}
