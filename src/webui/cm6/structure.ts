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

import { EditorSelection, EditorState, type ChangeSpec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { docModel } from "./doc-model";
import { voidAt, type LineInfo, type DocModel } from "./blockmodel";
import { focusCodeVoid } from "./voids/void-field";
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
 *  advances from the DISPLAY number (the run-correct value), so Enter writes the
 *  right literal even when this line's own literal has drifted; the renumber
 *  filter then converges the rest of the run. Bullet/todo keep the leading glyph
 *  the user used. */
function nextMarker(line: LineInfo): string {
  const glyph = line.text[line.indentChars] ?? "-";
  if (line.role === "numbered") return `${(line.displayNum ?? line.num ?? 1) + 1}. `;
  if (line.role === "todo") return `${glyph} [ ] `;
  return `${glyph} `;
}

/** The correct ordered number for a line placed at `newLevel`: continue the previous
 *  sibling's run there (+1), or 1 if it's the first item at that level (a shallower
 *  ancestor or a non-numbered sibling precedes it). Blank lines are transparent. */
function correctNumberAtLevel(model: DocModel, lineNumber: number, newLevel: number): number {
  for (let i = lineNumber - 2; i >= 0; i--) {
    const li = model.lines[i];
    if (!li || li.role === "blank") continue;
    if (li.level > newLevel) continue; // deeper sub-list — skip over it
    if (li.level < newLevel) return 1; // reached an ancestor → first child at newLevel
    return li.role === "numbered" ? (li.displayNum ?? li.num ?? 0) + 1 : 1; // same level: continue run or break
  }
  return 1;
}

// ---- ordered-list literal convergence -------------------------------------
//
// Numbering stance: there is no GLOBAL renumber (loading or merging a document
// never rewrites it), but a LOCAL user edit that touches a list cluster converges
// that cluster's literal numbers to the computed display numbers in the same
// transaction — one history event, one undo. This mirrors what the old editor's
// save-path `normalizeNumbering` achieved and keeps "what you see" equal to
// "what is stored": without it the literals drift (Enter writes num+1 into a
// stale run, paste/delete reorder items) and revealing the marker under the
// caret would show a different number than the widget just displayed.

/** Roles that keep a list cluster going when expanding the damage window. A blank
 *  line is transparent (runs continue across it — see assignDisplayNums), and any
 *  indented line is potentially a child of an item above. */
function listish(li: LineInfo): boolean {
  return li.role === "bullet" || li.role === "numbered" || li.role === "todo" || li.level > 0;
}

/** Transaction filter: after any local user edit, rewrite the literal digits of
 *  numbered lines in the touched list cluster(s) to their displayNum. Excluded:
 *  remote merges / programmatic setDoc (no userEvent), undo/redo (history must
 *  replay verbatim), island write-backs, and IME composition steps. The line
 *  whose marker region holds the selection is left alone — never fight the
 *  caret while the user is hand-editing a number (it converges on the next
 *  edit elsewhere). Idempotent: the appended fixes make literal == displayNum,
 *  so the re-run filter finds nothing and the transaction settles. */
export function renumberFilter(): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    if (!(tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move"))) return tr;
    if (tr.isUserEvent("input.writeback") || tr.isUserEvent("input.type.compose")) return tr;

    const model = docModel(tr.state);
    const lines = model.lines;
    if (!lines.length) return tr;

    // Damaged line span in the NEW doc.
    let lo = Infinity;
    let hi = -1;
    tr.changes.iterChanges((_fa, _ta, fb, tb) => {
      lo = Math.min(lo, tr.newDoc.lineAt(Math.min(fb, tr.newDoc.length)).number);
      hi = Math.max(hi, tr.newDoc.lineAt(Math.min(tb, tr.newDoc.length)).number);
    });
    if (hi < 0) return tr;

    // Expand to the enclosing list cluster: walk outward over listish lines,
    // skipping blanks only when another listish line continues beyond them
    // (a blank followed by top-level prose ends the cluster).
    const extend = (n: number, dir: -1 | 1): number => {
      let edge = n;
      let probe = n + dir;
      while (probe >= 1 && probe <= lines.length) {
        const li = lines[probe - 1]!;
        if (li.role === "blank") {
          probe += dir;
          continue; // transparent — include only if a listish line lies beyond
        }
        if (!listish(li)) break;
        edge = probe;
        probe += dir;
      }
      return edge;
    };
    lo = extend(lo, -1);
    hi = extend(hi, 1);

    const sel = tr.newSelection;
    const fixes: ChangeSpec[] = [];
    for (let n = lo; n <= hi; n++) {
      const li = lines[n - 1]!;
      if (li.role !== "numbered" || li.num === undefined || li.displayNum === undefined) continue;
      if (li.num === li.displayNum) continue;
      // Selection inside this marker region → the user may be editing the number.
      const caretInMarker = sel.ranges.some((r) => r.from < li.contentFrom && r.to >= li.markerFrom);
      if (caretInMarker) continue;
      const digits = li.numChars ?? String(li.num).length;
      fixes.push({ from: li.markerFrom, to: li.markerFrom + digits, insert: String(li.displayNum) });
    }
    return fixes.length ? [tr, { changes: fixes, sequential: true }] : tr;
  });
}

/** The change a fence opener typed as a list item's / quote's content expands to
 *  on Enter. Pure (no EditorView) so it is unit-testable:
 *    • list item whose content is EXACTLY a fence opener (``` / ```lang / ~~~…) →
 *      replace [contentFrom, to] with an indented fence pair on child lines
 *      (childIndent = item indent + 2 COLUMNS, matching the nesting grammar); the
 *      item line keeps its bare marker (an empty item);
 *    • quote line whose content is exactly a fence opener → rewrite the whole
 *      line [markerFrom, to] to a fence pair at the line's own indent (quote
 *      syntax cannot nest fences).
 *  `caretOffset` is relative to `insertFrom` and lands on the middle (empty
 *  code) line. Returns null when not applicable. */
export function fenceContinuation(
  line: LineInfo,
  lineText: string = line.text,
): { insertFrom: number; insertTo: number; insert: string; caretOffset: number } | null {
  const isList = line.role === "bullet" || line.role === "numbered" || line.role === "todo";
  const isQuote = line.role === "quote";
  if (!isList && !isQuote) return null;
  const content = lineText.slice(line.contentFrom - line.from);
  const m = content.match(RE.fenceOpen);
  if (!m) return null;
  const open = m[1]! + (m[2] ?? "");
  if (content !== open) return null; // EXACTLY a fence opener (no extra text/spaces)
  const close = m[1]![0]!.repeat(m[1]!.length); // same char (` or ~), same length

  if (isQuote) {
    const ws = lineText.slice(0, line.indentChars);
    const head = `${open}\n${ws}`;
    return {
      insertFrom: line.markerFrom,
      insertTo: line.to,
      insert: `${head}\n${ws}${close}`,
      caretOffset: head.length,
    };
  }
  const childIndent = " ".repeat(line.indent + 2);
  const head = `\n${childIndent}${open}\n${childIndent}`;
  return {
    insertFrom: line.contentFrom,
    insertTo: line.to,
    insert: `${head}\n${childIndent}${close}`,
    caretOffset: head.length,
  };
}

/** After a fence-completing dispatch, the new code range is an atomic void whose
 *  widget appears on the next DOM update — focus its island then. */
function focusNewCodeVoid(view: EditorView, pos: number) {
  requestAnimationFrame(() => {
    const v = voidAt(docModel(view.state), Math.min(pos, view.state.doc.length));
    if (v && v.kind === "code") focusCodeVoid(view, v, "start");
  });
}

/** Enter: continue a list/quote, exit an empty item, split at the caret; else let
 *  the default (newline, incl. code-void auto-indent) run. */
export function enterCommand(view: EditorView): boolean {
  if (view.composing) return false; // IME: Enter confirms the candidate
  const sel = view.state.selection.main;
  if (!sel.empty) return false; // typing over a selection → default replace+newline
  const line = lineAt(view, sel.head);

  // Unclosed opening code fence + Enter → complete the block: insert the matching
  // closing fence with an empty middle line. The scanner then sees a paired fence
  // (a code void, now atomic), so focus hands off to the new island's textarea as
  // soon as its widget exists. The opener line (incl. a ```lang info string) is
  // left verbatim.
  if (line.role === "p" && sel.head === line.to) {
    const m = line.text.match(RE.fenceOpen);
    if (m) {
      const indent = line.text.slice(0, line.indentChars);
      const close = m[1]![0]!.repeat(m[1]!.length); // same char (` or ~), same length
      const caret = line.to + 1 + indent.length;
      view.dispatch({
        changes: { from: line.to, insert: `\n${indent}\n${indent}${close}` },
        selection: { anchor: caret },
        userEvent: "input",
        scrollIntoView: true,
      });
      focusNewCodeVoid(view, caret);
      return true;
    }
  }

  // Fence opener typed as a list item's / quote's content + Enter at line end →
  // expand to a code block nested under the item (top-level for quotes) and focus
  // the new island.
  if (sel.head === line.to) {
    const fc = fenceContinuation(line);
    if (fc) {
      const caret = fc.insertFrom + fc.caretOffset;
      view.dispatch({
        changes: { from: fc.insertFrom, to: fc.insertTo, insert: fc.insert },
        selection: { anchor: caret },
        userEvent: "input",
        scrollIntoView: true,
      });
      focusNewCodeVoid(view, caret);
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
  if (view.composing) return false; // IME: Backspace edits the candidate
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
  if (view.composing) return false; // IME: leave the composition session alone
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

/** ArrowDown with the caret on the last visual row of the line just above a code
 *  void → enter the island (textarea caret at start). Code voids are atomic, so
 *  without this the default motion would skip the whole block. */
export function arrowIntoCodeBelow(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.head);
  if (line.to >= view.state.doc.length) return false;
  const v = docModel(view.state).voids.find((v) => v.kind === "code" && v.from === line.to + 1);
  if (!v) return false;
  // Wrapped line: only fire from its LAST visual row (otherwise move within it).
  const head = view.coordsAtPos(sel.head);
  const end = view.coordsAtPos(line.to);
  if (head && end && head.top < end.top - 1) return false;
  focusCodeVoid(view, v, "start");
  return true;
}

/** ArrowUp with the caret on the first visual row of the line just below a code
 *  void → enter the island (textarea caret at end). */
export function arrowIntoCodeAbove(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.head);
  if (line.from === 0) return false;
  const v = docModel(view.state).voids.find((v) => v.kind === "code" && v.to === line.from - 1);
  if (!v) return false;
  const head = view.coordsAtPos(sel.head);
  const start = view.coordsAtPos(line.from);
  if (head && start && head.top > start.top + 1) return false; // not on the first visual row
  focusCodeVoid(view, v, "end");
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
