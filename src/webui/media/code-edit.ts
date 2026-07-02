// Pure edit computations for the code island's textarea: Tab indent / Shift+Tab
// outdent and Enter auto-indent. DOM-free on purpose so they unit-test without
// mounting the widget; `applyTaEdit` is the one DOM touchpoint and routes the
// change through the island's existing write-back (setRangeText + synthetic
// "input" event → repaint + synchronous commit), so undo keeps living in CM
// history — never in the textarea's native undo stack (see voids/void-field.tsx
// CodeHost: Cmd+Z is intercepted and dispatched to CM).

/** One indent level. Two spaces, matching the block's CSS `tab-size:2`. */
export const INDENT = "  ";

/** A single-range textarea edit plus the selection to restore afterwards. */
export interface TaEdit {
  from: number;
  to: number;
  insert: string;
  selStart: number;
  selEnd: number;
}

/** Start index of the line containing `pos` (guarded: lastIndexOf with a
 *  negative fromIndex still probes index 0, which would misfire at pos 0). */
function lineStartAt(value: string, pos: number): number {
  return pos <= 0 ? 0 : value.lastIndexOf("\n", pos - 1) + 1;
}

/**
 * Tab / Shift+Tab. Three shapes:
 *   • plain Tab, selection within one line → replace it with one indent level;
 *   • plain Tab, selection spanning lines → prepend INDENT to every touched
 *     non-empty line (empty lines stay empty — no stray trailing whitespace);
 *   • Shift+Tab (any selection) → strip up to INDENT.length leading SPACES from
 *     every touched line (tabs are left alone; outdent only undoes our indent).
 * A selection ending at column 0 does not touch that line (standard editor
 * behavior). Returns null when the edit would be a no-op, so the caller can
 * skip the write-back and not pollute CM history with empty transactions.
 */
export function tabEdit(
  value: string,
  selStart: number,
  selEnd: number,
  outdent: boolean,
): TaEdit | null {
  if (!outdent && !value.slice(selStart, selEnd).includes("\n")) {
    const caret = selStart + INDENT.length;
    return { from: selStart, to: selEnd, insert: INDENT, selStart: caret, selEnd: caret };
  }

  const first = lineStartAt(value, selStart);
  const effEnd = selEnd > selStart && value[selEnd - 1] === "\n" ? selEnd - 1 : selEnd;
  let blockEnd = value.indexOf("\n", effEnd);
  if (blockEnd === -1) blockEnd = value.length;
  const lines = value.slice(first, blockEnd).split("\n");

  if (!outdent) {
    const out = lines.map((l) => (l === "" ? l : INDENT + l));
    const total = out.reduce((n, l, i) => n + (l.length - lines[i]!.length), 0);
    const addedFirst = out[0]!.length - lines[0]!.length;
    return {
      from: first,
      to: blockEnd,
      insert: out.join("\n"),
      selStart: selStart + addedFirst,
      selEnd: selEnd + total,
    };
  }

  const out = lines.map((l) => l.replace(/^ {1,2}/, ""));
  const total = lines.reduce((n, l, i) => n + (l.length - out[i]!.length), 0);
  if (total === 0) return null;
  const removedFirst = lines[0]!.length - out[0]!.length;
  const removedLast = lines[lines.length - 1]!.length - out[out.length - 1]!.length;
  // Old start of the block's last line; clamp selEnd there so a caret sitting
  // inside the removed whitespace cannot escape onto the previous line.
  const lastLineStart = blockEnd - lines[lines.length - 1]!.length;
  const newStart = Math.max(first, selStart - removedFirst);
  const newEnd = Math.max(
    newStart,
    Math.max(lastLineStart - (total - removedLast), selEnd - total),
  );
  return { from: first, to: blockEnd, insert: out.join("\n"), selStart: newStart, selEnd: newEnd };
}

/**
 * Enter: newline that inherits the current line's leading whitespace (only the
 * part before the caret, so pressing Enter mid-indent doesn't over-indent),
 * plus one extra level when the text before the caret ends with an opening
 * bracket or a colon. Any active selection is replaced by the newline.
 */
export function newlineEdit(value: string, selStart: number, selEnd: number): TaEdit {
  const before = value.slice(lineStartAt(value, selStart), selStart);
  const indent = /^[ \t]*/.exec(before)![0]!;
  const extra = /[({[:]$/.test(before.trimEnd()) ? INDENT : "";
  const insert = "\n" + indent + extra;
  const caret = selStart + insert.length;
  return { from: selStart, to: selEnd, insert, selStart: caret, selEnd: caret };
}

/** Apply a TaEdit through the island's normal write-back path: setRangeText
 *  keeps the browser from touching focus/scroll, and the synthetic "input"
 *  event drives the same repaint + commit as real typing (undo stays in CM). */
export function applyTaEdit(ta: HTMLTextAreaElement, ed: TaEdit): void {
  ta.setRangeText(ed.insert, ed.from, ed.to);
  ta.setSelectionRange(ed.selStart, ed.selEnd);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}
