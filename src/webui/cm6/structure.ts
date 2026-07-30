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
import { hiddenIndentChars, voidAt, quoteRunAt, correctNumberAtLevel, isListRole, type LineInfo, type DocModel } from "./blockmodel";
import { focusCodeVoid } from "./voids/void-field";
import { RE, leadingIndent } from "../blocks";

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
 *  advances from this line's LITERAL number — literal numbers are authoritative;
 *  the editor generates numbers only at creation time (here, Tab, convert) and
 *  never rewrites existing ones. Bullet/todo keep the leading glyph the user used. */
function nextMarker(line: LineInfo): string {
  const glyph = line.text[line.indentChars] ?? "-";
  if (line.role === "numbered") {
    // Keep this line's separator style: `3) item` continues as `4) `, not `4. `
    // (the grammar accepts both; reindent preserves the tail the same way).
    const sep = /^\d+([.)])/.exec(line.text.slice(line.indentChars))?.[1] ?? ".";
    return `${(line.num ?? 1) + 1}${sep} `;
  }
  if (line.role === "todo") return `${glyph} [ ] `;
  return `${glyph} `;
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
  const isList = isListRole(line.role);
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
 *  widget appears on the next DOM update — focus its island then. One retry:
 *  CM can materialize the widget a frame late (large doc, pending scroll), and
 *  focusCodeVoid silently no-ops when the island isn't mounted yet. */
export function focusNewCodeVoid(view: EditorView, pos: number, attempt = 0) {
  requestAnimationFrame(() => {
    const v = voidAt(docModel(view.state), Math.min(pos, view.state.doc.length));
    if (!v || v.kind !== "code") return;
    focusCodeVoid(view, v, "start");
    if (attempt === 0 && !document.activeElement?.closest?.(".cm-void-code"))
      focusNewCodeVoid(view, pos, 1);
  });
}

/** Title → body: put the caret at the top of the document. When the FIRST block
 *  is a void (image/table/code/…), position 0 is the first offset of its source
 *  line — a dispatched selection lands there editable (atomicRanges only guards
 *  motion) and typing would corrupt the void. Open a fresh line above instead
 *  (the old editor's insertTop('p') semantics; same move as CodeHost's
 *  ArrowUp-at-doc-start). */
export function enterDocTop(view: EditorView) {
  const v = voidAt(docModel(view.state), 0);
  if (v && v.from === 0) {
    view.dispatch({
      changes: { from: 0, insert: "\n" },
      selection: { anchor: 0 },
      userEvent: "input",
      scrollIntoView: true,
    });
  } else {
    view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
  }
  view.focus();
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
    // Auto-complete only when the line is EXACTLY a fence opener (`\`\`\`` +
    // optional pure lang, no trailing content) — matching fenceContinuation's
    // strictness. The shared RE.fenceOpen tolerates a trailing info string
    // (CommonMark-correct for the parser), but a prose line like `\`\`\`not code`
    // must not silently become a code block on Enter.
    if (m && line.text.slice(line.indentChars) === m[1]! + (m[2] ?? "")) {
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

  const isList = isListRole(line.role);
  const isQuote = line.role === "quote";
  if (!isList && !isQuote) return false;

  // Caret before the content start. Two distinct positions get here:
  //   • the very line start — a legal caret stop on ANY marked line (ArrowLeft
  //     past the atomic marker, smartHome's second press): Enter pushes the
  //     item down by opening an empty line above (the old editor's
  //     split-at-item-start), caret staying with the item;
  //   • strictly inside a numbered marker (the ordinal is editable text): jump
  //     to the content start instead of splitting the marker ("1\n2. . item").
  if (sel.head === line.from) {
    view.dispatch({
      changes: { from: line.from, insert: "\n" },
      selection: { anchor: line.from + 1 },
      userEvent: "input",
      scrollIntoView: true,
    });
    return true;
  }
  if (sel.head < line.contentFrom) {
    view.dispatch({ selection: { anchor: line.contentFrom }, userEvent: "select" });
    return true;
  }

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

/** Re-level a single ordered item by one nesting step — the one moment we
 *  (re)generate its number: set it to the correct value for its NEW nesting
 *  level, in the same transaction. Only this moved item is touched — siblings /
 *  user-set / out-of-order numbers are left alone (no global renumber). Column
 *  math (line.indent), not char math. Shared by Tab/Shift-Tab (reindent) and
 *  Backspace-at-hidden-indent, so the ordinal regenerates identically on both. */
function relevelNumbered(view: EditorView, line: LineInfo, delta: 1 | -1): boolean {
  const { state } = view;
  const newIndentCols = delta > 0 ? line.indent + 2 : Math.max(0, line.indent - 2);
  if (newIndentCols === line.indent) return true; // already flush-left, can't outdent
  const newLevel = Math.floor(newIndentCols / 2);
  const num = correctNumberAtLevel(docModel(state).lines, line.number, newLevel);
  const oldMarker = line.text.slice(line.indentChars, line.contentFrom - line.from); // "3. " / "3) "
  const tail = oldMarker.slice(line.numChars ?? String(line.num ?? 1).length); // ". " / ") "
  const prefix = " ".repeat(newIndentCols) + num + tail;
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

/** Backspace: at the caret-after-marker position, strip the marker (→ paragraph);
 *  at the first visible char of a fully-hidden indent, outdent one level;
 *  otherwise let the default character/line delete run. */
export function backspaceCommand(view: EditorView): boolean {
  if (view.composing) return false; // IME: Backspace edits the candidate
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = lineAt(view, sel.head);

  // Caret sits right after a block marker (`# `, `- `, `1. `, `- [ ] `, `> `) →
  // remove indent + marker so the line becomes a plain paragraph. Only when there
  // actually IS a marker (contentFrom past the line start).
  // NOT numbered: the ordinal is ordinary, user-editable text — Backspace at the
  // content start walks into it char by char (space → separator → digits; with
  // the digits gone the line is a paragraph again). Only the constant markers
  // (bullet glyph, checkbox, `> `, `# `) strip as a unit.
  const marked =
    line.role === "bullet" ||
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

  // Caret at the first visible char of an indented line whose entire indent is
  // hidden behind the 24px column grid (canonical level*2 columns): Backspace
  // steps out one level instead of eating one invisible space. Numbered items
  // re-level through the same path as Shift-Tab so their ordinal regenerates.
  // A visible odd remainder space falls through: default Backspace deletes it.
  if (
    sel.head === line.markerFrom &&
    line.indentChars > 0 &&
    line.role !== "void" &&
    line.role !== "bullet" &&
    line.role !== "todo" &&
    line.role !== "blank" &&
    hiddenIndentChars(line) === line.indentChars
  ) {
    if (line.role === "numbered") return relevelNumbered(view, line, -1);
    const ws = " ".repeat(Math.max(0, (line.level - 1) * 2));
    view.dispatch({
      changes: { from: line.from, to: line.from + line.indentChars, insert: ws },
      selection: { anchor: line.from + ws.length },
      userEvent: "delete.dedent",
      scrollIntoView: true,
    });
    return true;
  }

  // Whitespace-only line (the residue after Backspace walks through an indented
  // marker char by char): the leading whitespace is nesting indent, not ordinary
  // text — it's never visible as characters — so delete the whole run at once
  // instead of leaving the caret hovering after invisible spaces.
  if (line.role === "blank" && sel.head > line.from) {
    view.dispatch({
      changes: { from: line.from, to: sel.head, insert: "" },
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
 *  one nesting level (2 columns). Tab NEVER inserts literal spaces at the caret
 *  (except revealed void source): it rewrites the line's leading whitespace, and
 *  the key is always consumed so focus can't leak out of the editor. Lines whose
 *  leading whitespace contains literal tabs are normalized to spaces by COLUMN
 *  width (a `\t` is 4 columns but 1 char — char-based math used to jump levels). */
function reindent(view: EditorView, delta: 1 | -1): boolean {
  if (view.composing) return false; // IME: leave the composition session alone
  const { state } = view;
  const ranges = state.selection.ranges;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();

  const single = state.selection.main.empty && ranges.length === 1;
  const caretLine = lineAt(view, state.selection.main.head);
  const caretIsList =
    isListRole(caretLine.role);

  // A quote is a MULTI-LINE block (a contiguous same-level `> ` run): the caret
  // line steps together with its whole run, or Tab would tear one quote into
  // two half-indented blocks. Must run before the generic single-caret branches
  // below (a quote is `!caretIsList` and would be caught there line-wise). Same
  // normalize semantics as those branches: every run line snaps to the caret
  // level's canonical target — odd indents and tabbed prefixes heal in passing.
  if (single && caretLine.role === "quote") {
    const target =
      delta > 0
        ? (caretLine.level + 1) * 2
        : caretLine.indent > caretLine.level * 2
          ? caretLine.level * 2
          : Math.max(0, (caretLine.level - 1) * 2);
    if (target === caretLine.indent) return true; // flush-left outdent: consume
    const model = docModel(state);
    const run = quoteRunAt(model.lines, state.doc.lineAt(state.selection.main.head).number);
    const ws = " ".repeat(target);
    for (let n = run.fromLine; n <= run.toLine; n++) {
      const line = model.lines[n - 1]!;
      if (line.indentChars === ws.length && !line.text.slice(0, ws.length).includes("\t")) continue;
      changes.push({ from: line.from, to: line.from + line.indentChars, insert: ws });
    }
    if (!changes.length) return true;
    const cs = state.changes(changes);
    const head = state.selection.main.head;
    const contentStart = cs.mapPos(caretLine.from, -1) + ws.length;
    view.dispatch({
      changes,
      selection: { anchor: Math.max(contentStart, cs.mapPos(head, 1)) },
      userEvent: delta > 0 ? "input.indent" : "delete.dedent",
      scrollIntoView: true,
    });
    return true;
  }

  // Empty selection on a non-list line. Revealed void source (html) keeps real
  // space insertion (code-style indent); any other block line — EMPTY lines
  // included (Tab on an empty block indents it; the placeholder shifts along) —
  // indents freely by one nesting level per press, no list-context requirement
  // and no cap (the old editor never indented prose, but that was overruled:
  // Tab must always have a visible effect). The whole leading run is rewritten,
  // so odd spaces and tabs normalize to the canonical 2-space-per-level form.
  if (delta > 0 && single && !caretIsList) {
    if (caretLine.role === "void") {
      view.dispatch(state.replaceSelection("  "));
      return true;
    }
    const ws = " ".repeat((caretLine.level + 1) * 2);
    const head = state.selection.main.head;
    const grow = ws.length - caretLine.indentChars;
    view.dispatch({
      changes: { from: caretLine.from, to: caretLine.from + caretLine.indentChars, insert: ws },
      selection: { anchor: Math.max(caretLine.from + ws.length, head + grow) },
      userEvent: "input.indent",
      scrollIntoView: true,
    });
    return true;
  }

  // Empty selection on a non-list, non-void line, Shift-Tab: the symmetric
  // single-caret outdent. Normalize-then-outdent: an odd indent first snaps to
  // its canonical level*2 columns, then steps down a level. Flush-left consumes
  // the key. Void lines fall through to the multi-line loop (strip 1-2 leading
  // spaces = normal code dedent).
  if (delta < 0 && single && !caretIsList && caretLine.role !== "void") {
    const cols =
      caretLine.indent > caretLine.level * 2
        ? caretLine.level * 2
        : Math.max(0, (caretLine.level - 1) * 2);
    if (cols === caretLine.indent) return true; // flush-left: nothing to outdent
    const ws = " ".repeat(cols);
    const head = state.selection.main.head;
    const shrink = caretLine.indentChars - ws.length;
    view.dispatch({
      changes: { from: caretLine.from, to: caretLine.from + caretLine.indentChars, insert: ws },
      selection: { anchor: Math.max(caretLine.from + ws.length, head - shrink) },
      userEvent: "delete.dedent",
      scrollIntoView: true,
    });
    return true;
  }

  // Re-leveling a single ordered item is the one moment we (re)generate its
  // number — see relevelNumbered (shared with Backspace-at-hidden-indent).
  if (single && caretLine.role === "numbered") {
    return relevelNumbered(view, caretLine, delta);
  }

  const model = docModel(state);
  for (const r of ranges) {
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      const v = voidAt(model, state.doc.line(n).from);
      // A void steps as ONE block, keyed off its OPENING line: every source
      // line shifts by the same amount, so the interior's RELATIVE indentation
      // (code!) is never rewritten. Only literal leading SPACES are touched —
      // a tab inside a code block is content, never normalized. Shift-Tab on a
      // flush-left void is a whole-void no-op (the key is still consumed).
      // Exception: a caret/partial range INSIDE a revealed html void is source
      // editing — those lines keep the per-line code-style dedent/indent below;
      // atomic voids can't be entered, so any touch means the block gesture.
      if (v && (v.kind !== "html" || (r.from <= v.from && r.to >= v.to))) {
        for (let m = v.fromLine; m <= v.toLine; m++) seen.add(m);
        const openSpaces = /^ */.exec(state.doc.line(v.fromLine).text)![0].length;
        if (delta > 0) {
          for (let m = v.fromLine; m <= v.toLine; m++)
            changes.push({ from: state.doc.line(m).from, insert: "  " });
        } else {
          const strip = Math.min(2, openSpaces);
          for (let m = v.fromLine; strip > 0 && m <= v.toLine; m++) {
            const line = state.doc.line(m);
            const take = Math.min(strip, /^ */.exec(line.text)![0].length);
            if (take > 0) changes.push({ from: line.from, to: line.from + take, insert: "" });
          }
        }
        n = v.toLine;
        continue;
      }
      seen.add(n);
      const line = state.doc.line(n);
      const ws = /^[ \t]*/.exec(line.text)![0];
      if (ws.includes("\t")) {
        // Normalize a tabbed indent to spaces at the shifted COLUMN width.
        const cols = Math.max(0, leadingIndent(line.text) + delta * 2);
        changes.push({ from: line.from, to: line.from + ws.length, insert: " ".repeat(cols) });
      } else if (delta > 0) {
        changes.push({ from: line.from, insert: "  " });
      } else {
        const strip = /^ {1,2}/.exec(line.text);
        if (strip) changes.push({ from: line.from, to: line.from + strip[0].length, insert: "" });
      }
    }
  }
  if (!changes.length) return true; // nothing to outdent, but consume the key
  const main = state.selection.main;
  // A selection exactly covering one void (the accent-ring state) must still
  // cover it afterwards: CM maps an anchor AT an insertion point to AFTER the
  // inserted text, which would break the ring and makeVoidExit's exact match —
  // pin both endpoints to the (mapped) void span instead.
  const cover =
    ranges.length === 1 ? model.voids.find((v) => v.from === main.from && v.to === main.to) : undefined;
  let selection: { anchor: number; head: number } | undefined;
  if (cover) {
    const cs = state.changes(changes);
    selection = { anchor: cs.mapPos(cover.from, -1), head: cs.mapPos(cover.to, 1) };
  }
  view.dispatch({ changes, selection, userEvent: delta > 0 ? "input.indent" : "delete.dedent" });
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

/** Arrow keys while a void is SELECTED (the CM selection is exactly the void's
 *  range — the accent-ring state a click produces): move the caret to the line
 *  after (dir 1: Down/Right) or before (dir -1: Up/Left) the void. The default
 *  motions strand the caret on the void's atomic edge, where nothing visible can
 *  render. When the void is the document's first/last block there IS no such
 *  line, so create one — the caret must land somewhere editable. */
export function makeVoidExit(dir: 1 | -1) {
  return function voidExit(view: EditorView): boolean {
    const sel = view.state.selection.main;
    if (sel.empty) return false;
    const v = docModel(view.state).voids.find((v) => v.from === sel.from && v.to === sel.to);
    if (!v) return false;
    const doc = view.state.doc;
    if (dir === 1) {
      if (v.to >= doc.length)
        view.dispatch({
          changes: { from: doc.length, insert: "\n" },
          selection: { anchor: doc.length + 1 },
          userEvent: "input",
        });
      else view.dispatch({ selection: { anchor: doc.lineAt(v.to + 1).from }, userEvent: "select" });
    } else {
      if (v.from <= 0)
        view.dispatch({ changes: { from: 0, insert: "\n" }, selection: { anchor: 0 }, userEvent: "input" });
      else view.dispatch({ selection: { anchor: doc.lineAt(v.from - 1).to }, userEvent: "select" });
    }
    return true;
  };
}

/** Arrow into an adjacent code island: dir 1 = ArrowDown into the code void
 *  starting on the next line (textarea caret at start), dir -1 = ArrowUp into
 *  the void ending on the previous line (caret at end). Code voids are atomic,
 *  so without this the default motion would skip the whole block. One factory
 *  instead of two hand-mirrored functions — the wrapped-line guard (the ±1px
 *  visual-row fudge) can never be fixed in one direction and missed in the
 *  other (same pattern as makeVoidExit). */
function makeArrowIntoCode(dir: 1 | -1) {
  return (view: EditorView): boolean => {
    const sel = view.state.selection.main;
    if (!sel.empty) return false;
    const line = view.state.doc.lineAt(sel.head);
    if (dir === 1 ? line.to >= view.state.doc.length : line.from === 0) return false;
    const v = docModel(view.state).voids.find(
      (v) => v.kind === "code" && (dir === 1 ? v.from === line.to + 1 : v.to === line.from - 1),
    );
    if (!v) return false;
    // Wrapped line: only fire from the edge visual row facing the void
    // (otherwise the arrow moves within the wrapped line).
    const head = view.coordsAtPos(sel.head);
    const edge = view.coordsAtPos(dir === 1 ? line.to : line.from);
    if (head && edge && (dir === 1 ? head.top < edge.top - 1 : head.top > edge.top + 1)) return false;
    focusCodeVoid(view, v, dir === 1 ? "start" : "end");
    return true;
  };
}
export const arrowIntoCodeBelow = makeArrowIntoCode(1);
export const arrowIntoCodeAbove = makeArrowIntoCode(-1);

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

/** Backspace at the very start of the document: the block ABOVE the first line is
 *  the title, so the line merges INTO it — the host appends the text and parks the
 *  caret at the seam, and the line (plus its newline) goes away. Same title/body
 *  seam as makeExitTop (ArrowUp), delete direction.
 *
 *  What merges is the line's CONTENT, not its raw text: a block absorbed by the
 *  block above loses its own type, so `1. foo` hands over `foo` and the marker
 *  dies with the line. Deliberately coords-free (unlike makeExitTop) — position 0
 *  is unambiguously the first visual row, so the command stays headless-testable. */
export function makeMergeTop(onMergeTop?: (text: string) => boolean) {
  return function mergeTop(view: EditorView): boolean {
    if (!onMergeTop || view.composing) return false;
    const sel = view.state.selection.main;
    if (!sel.empty || sel.head !== 0) return false;
    const model = docModel(view.state);
    // A void opening the document owns its own Backspace (select, then delete).
    if (voidAt(model, 0)) return false;
    const line = model.lines[0];
    if (!line) return false;
    const text = view.state.sliceDoc(line.contentFrom, line.to);
    if (!onMergeTop(text)) return false; // no title host — hand the key back
    const to = Math.min(view.state.doc.length, line.to + 1); // take the newline too
    if (to > 0) {
      view.dispatch({ changes: { from: 0, to, insert: "" }, selection: { anchor: 0 }, userEvent: "delete" });
    }
    return true;
  };
}
