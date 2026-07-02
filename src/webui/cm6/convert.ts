// "Turn into" — block-type conversion for the flat CM6 editor.
//
// In the flat model a block's type IS its line prefix, so conversion is just
// rewriting that prefix: strip everything between the leading indent and
// `contentFrom` (the model already knows where the marker ends) and write the
// new marker. The whole range is converted in ONE dispatched transaction
// (`userEvent: "input.convert"`), so undo restores it in a single step.
//
// The core (`turnIntoChanges`) is a pure function over the scanned model — no
// EditorView — so it is unit-testable with `scanDoc` fixtures; `turnInto` is
// the thin view wrapper the gutter menu calls.

import type { EditorView } from "@codemirror/view";
import type { LineInfo, VoidRange } from "./blockmodel";
import { docModel } from "./doc-model";

/** Types a block can be turned into. `divider` only applies to a single line;
 *  media/table voids are never convertible (their bytes/cells would be lost). */
export type TargetType =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "quote"
  | "bullet"
  | "numbered"
  | "todo"
  | "code"
  | "divider";

/** A single text edit; the shape CM's `dispatch({ changes })` accepts. */
export interface LineChange {
  from: number;
  to: number;
  insert: string;
}

const PREFIX: Record<Exclude<TargetType, "numbered" | "code" | "divider">, string> = {
  p: "",
  h1: "# ",
  h2: "## ",
  h3: "### ",
  quote: "> ",
  bullet: "- ",
  todo: "- [ ] ",
};

type Slice = (from: number, to: number) => string;

/** Where a line's marker prefix ends. A divider's `---` is ALL marker (its
 *  contentFrom sits at the marker start, but converting must not keep the
 *  dashes as text), so the prefix runs to the line end. */
function prefixEnd(line: LineInfo): number {
  return line.role === "divider" ? line.to : line.contentFrom;
}

/** Starting number for the FIRST converted line at nesting level `level`:
 *  continue from the preceding same-level numbered sibling, else 1. Mirrors
 *  `assignDisplayNums` run semantics — blanks and deeper lines are transparent,
 *  any same-or-shallower non-numbered line breaks the run. */
function numberedStart(lines: LineInfo[], lineNo: number, level: number): number {
  for (let i = lineNo - 2; i >= 0; i--) {
    const l = lines[i]!;
    if (l.role === "blank") continue;
    if (l.level > level) continue; // a child of some outer item — transparent
    if (l.role === "numbered" && l.level === level) return (l.displayNum ?? l.num ?? 1) + 1;
    return 1; // same-or-shallower non-sibling breaks the run
  }
  return 1;
}

/** The void containing 1-based line `n`, if any. */
function voidAtLine(voids: VoidRange[], n: number): VoidRange | undefined {
  return voids.find((v) => n >= v.fromLine && n <= v.toLine);
}

/** Unwrap a fenced code/html void into its content lines: one change replacing
 *  the whole void source with the inner lines (fences dropped, indent kept).
 *  An empty fence (open + close only) becomes an empty line. */
function unwrapFence(lines: LineInfo[], v: VoidRange, slice: Slice): LineChange {
  const content =
    v.toLine - v.fromLine >= 2 ? slice(lines[v.fromLine]!.from, lines[v.toLine - 2]!.to) : "";
  return { from: v.from, to: v.to, insert: content };
}

/**
 * Pure core: compute the edits that turn lines `fromLine..toLine` (1-based,
 * inclusive) into `type`. Returns null when there is nothing to change (blank
 * range, unconvertible void, same type already, multi-line divider…).
 *
 * Per line: blank lines are skipped; code/html voids unwrap when the target is
 * `p` and are skipped otherwise; media/table voids are always skipped (lossy —
 * the menu excludes them anyway). `code` wraps the whole range in one fence
 * instead of per-line prefixing; `divider` replaces a single line only.
 */
export function turnIntoChanges(
  lines: LineInfo[],
  voids: VoidRange[],
  slice: Slice,
  fromLine: number,
  toLine: number,
  type: TargetType,
): LineChange[] | null {
  fromLine = Math.max(1, fromLine);
  toLine = Math.min(lines.length, toLine);
  if (toLine < fromLine) return null;

  if (type === "divider") {
    if (fromLine !== toLine) return null; // multi-line divider is nonsense
    const line = lines[fromLine - 1]!;
    if (line.role === "void" || line.role === "divider") return null;
    return [{ from: line.from, to: line.to, insert: "---" }];
  }

  if (type === "code") return wrapCode(lines, voids, slice, fromLine, toLine);

  const changes: LineChange[] = [];
  // Per nesting level, the last number written by THIS conversion; the first
  // line at a level seeds from the preceding sibling run (numberedStart).
  const counters = new Map<number, number>();

  let n = fromLine;
  while (n <= toLine) {
    const line = lines[n - 1]!;
    if (line.role === "blank") {
      n++;
      continue;
    }
    if (line.role === "void") {
      const v = voidAtLine(voids, n)!;
      if ((v.kind === "code" || v.kind === "html") && type === "p") {
        changes.push(unwrapFence(lines, v, slice));
      } // media/table (and code→non-p): lossy or meaningless — skip untouched
      n = v.toLine + 1;
      continue;
    }

    let prefix: string;
    if (type === "numbered") {
      const level = line.level;
      for (const k of [...counters.keys()]) if (k > level) counters.delete(k); // deeper runs end
      const prev = counters.get(level);
      const num = prev != null ? prev + 1 : numberedStart(lines, n, level);
      counters.set(level, num);
      prefix = `${num}. `;
    } else {
      prefix = PREFIX[type];
    }

    const from = line.markerFrom;
    const to = prefixEnd(line);
    if (slice(from, to) !== prefix) changes.push({ from, to, insert: prefix });
    n++;
  }

  return changes.length ? changes : null;
}

/** Turn the range into ONE fenced code block: strip every line's prefix, drop
 *  fences of code/html voids inside the range (their content merges in), and
 *  wrap with fence lines at the range's minimum indent. Fence grows past any
 *  backtick run in the content. Media/table voids in range → null (lossy). */
function wrapCode(
  lines: LineInfo[],
  voids: VoidRange[],
  slice: Slice,
  fromLine: number,
  toLine: number,
): LineChange[] | null {
  const inRange = voids.filter((v) => v.fromLine <= toLine && v.toLine >= fromLine);
  for (const v of inRange) if (v.kind !== "code" && v.kind !== "html") return null;
  // Already exactly one code block → nothing to do.
  if (inRange.length === 1 && inRange[0]!.fromLine <= fromLine && inRange[0]!.toLine >= toLine) return null;
  // Snap to whole voids so a partially-selected fence isn't cut in half.
  for (const v of inRange) {
    fromLine = Math.min(fromLine, v.fromLine);
    toLine = Math.max(toLine, v.toLine);
  }

  const changes: LineChange[] = [];
  const contents: string[] = []; // resulting inner lines, for fence sizing
  let minIndentChars = Infinity;
  let indent = "";
  const noteIndent = (line: LineInfo) => {
    if (line.indentChars < minIndentChars) {
      minIndentChars = line.indentChars;
      indent = line.text.slice(0, line.indentChars);
    }
  };

  let n = fromLine;
  while (n <= toLine) {
    const line = lines[n - 1]!;
    if (line.role === "void") {
      const v = voidAtLine(voids, n)!;
      if (v.toLine - v.fromLine >= 2) {
        const open = lines[v.fromLine - 1]!;
        const close = lines[v.toLine - 1]!;
        changes.push({ from: open.from, to: open.to + 1, insert: "" }); // fence + newline
        changes.push({ from: close.from - 1, to: close.to, insert: "" }); // newline + fence
        for (let m = v.fromLine + 1; m <= v.toLine - 1; m++) {
          const inner = lines[m - 1]!;
          contents.push(inner.text);
          if (inner.text.trim() !== "") noteIndent(inner);
        }
      } else {
        changes.push({ from: v.from, to: v.to, insert: "" }); // empty fence → blank line
        contents.push("");
      }
      n = v.toLine + 1;
      continue;
    }
    const to = prefixEnd(line);
    if (to > line.markerFrom) changes.push({ from: line.markerFrom, to, insert: "" });
    contents.push(line.text.slice(0, line.indentChars) + line.text.slice(to - line.from));
    if (line.role !== "blank") noteIndent(line);
    n++;
  }
  if (!Number.isFinite(minIndentChars)) indent = "";

  let maxRun = 0;
  for (const c of contents) for (const m of c.matchAll(/`+/g)) maxRun = Math.max(maxRun, m[0]!.length);
  const fence = "`".repeat(maxRun >= 3 ? maxRun + 1 : 3);

  const start = lines[fromLine - 1]!.from;
  const end = lines[toLine - 1]!.to;
  changes.push({ from: start, to: start, insert: indent + fence + "\n" });
  changes.push({ from: end, to: end, insert: "\n" + indent + fence });
  return changes;
}

/** View wrapper: convert lines `fromLine..toLine` to `type` in one transaction
 *  (single undo step). Returns true when anything changed. */
export function turnInto(view: EditorView, fromLine: number, toLine: number, type: TargetType): boolean {
  const model = docModel(view.state);
  const changes = turnIntoChanges(
    model.lines,
    model.voids,
    (from, to) => view.state.sliceDoc(from, to),
    fromLine,
    toLine,
    type,
  );
  if (!changes) return false;
  view.dispatch({ changes, userEvent: "input.convert" });
  return true;
}
