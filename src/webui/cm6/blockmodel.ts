// Offset-bearing block scanner for the single-document CM6 editor.
//
// The editor's document IS the raw Markdown body; "blocks" are a derived
// presentation layer. This module turns the current document text into a flat,
// offset-indexed model that drives every decoration, void widget, and structure
// key: `scanDoc(src)` walks the lines once and returns
//   • `lines[]` — one entry per document line with its role + the char offsets a
//     decoration needs (leading-indent range, marker range, content start),
//   • `voids[]`  — the source ranges of block-level embeds (fenced code / html,
//     GFM tables, single-line media) with their parsed `Block` for the widget, and
//   • `headings[]` — the h1–h6 lines (offset + raw text) for TOC-style consumers.
//
// It reuses the line grammar from `blocks.ts` (the SAME predicates the save path
// parses with) so the on-screen model can never drift from what a save/reload
// produces. It is intentionally CM-free (operates on plain strings / a minimal
// `LineSource`) so it is trivially unit-testable.
//
// `patchScan(prev, edits, src)` is the incremental sibling used on every
// transaction: it re-runs the SAME scan, but only over the damaged line window
// (widened so no fence/table construct straddles a window edge), and splices the
// result into the previous model. Per-keystroke cost is proportional to the
// damaged region plus cheap O(lines) passes (display numbers, headings) that do
// no regex or parsing.
//
// Unlike `blocksFromBody`, this scanner is FLAT: indentation is literal document
// text, not tree nesting. A nested list item is just a line with leading spaces;
// its visual indent is a padding decoration derived from `indent`, never a child
// relationship. This is what lets caret/selection/undo stay native CM6 behavior.

import {
  RE,
  HTML_FENCE,
  leadingIndent,
  stripIndent,
  isFenceClose,
  cleanLang,
  matchListLine,
  matchQuoteLine,
  matchMediaLine,
  looksLikeTableAt,
  parseTableBlock,
  textToBlock,
  makeBlock,
  type Block,
} from "../blocks";

/** The visual role of a single document line. `void` covers every line that is
 *  part of a block-level embed's source (a fence line, a table row, a media
 *  line) — those are owned by `voids[]`, not decorated as prose. */
export type LineRole =
  | "p"
  | "blank"
  | "divider"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "bullet"
  | "numbered"
  | "todo"
  | "quote"
  | "void";

export interface LineInfo {
  /** 1-based line number (matches CM `Text.line(n).number`). */
  number: number;
  /** Absolute offset of the line start (matches CM `line.from`). */
  from: number;
  /** Absolute offset of the line end, before the trailing newline (`line.to`). */
  to: number;
  /** Full line text (no newline). */
  text: string;
  role: LineRole;
  /** Leading-indent width in columns (tab = 4); drives list `padding-left`. */
  indent: number;
  /** Number of leading whitespace CHARACTERS (for offset math; a tab is 1 char). */
  indentChars: number;
  /** Visual nesting level for lists = floor(indent / 2). */
  level: number;
  /** Offset where the marker prefix begins (= from + indentChars). For prose this
   *  equals `contentFrom`. */
  markerFrom: number;
  /** Offset where the line's editable content begins, after any marker
   *  (`# `, `- `, `1. `, `- [ ] `, `> `). The Smart-Home / marker-hide target. */
  contentFrom: number;
  /** numbered: the literal number the user typed. Authoritative — it is what
   *  displays, what the user edits as plain text, and what saves; the editor
   *  generates numbers only when CREATING items (Enter/Tab/convert). */
  num?: number;
  /** numbered: length of the literal digit run (for rewriting just the digits on a
   *  Tab-renumber; not `String(num).length`, so `01.` / `007.` map correctly). */
  numChars?: number;
  /** todo: checkbox state parsed from `[ ]` / `[x]`. */
  checked?: boolean;
}

export type VoidKind = "code" | "html" | "image" | "video" | "audio" | "file" | "table";

export interface VoidRange {
  /** Offset of the first source line's start. A block replace decoration must
   *  begin at a line start. */
  from: number;
  /** Offset of the last source line's end, BEFORE its trailing newline. A block
   *  replace decoration must end at a line end; the newline stays in the doc and
   *  forms the gap to the next block. */
  to: number;
  /** 1-based inclusive line span. */
  fromLine: number;
  toLine: number;
  kind: VoidKind;
  /** Parsed block for the widget host (Phase 2). Ids are fresh/ephemeral. */
  block: Block;
}

/** One h1–h6 line, extracted once per scan so consumers (TOC) never re-walk the
 *  lines. `text` is the RAW heading source after the `#` marker (no inline-token
 *  stripping — that stays in the consumer). */
export interface DocHeading {
  /** Line-start offset of the heading line (= its LineInfo.from). */
  from: number;
  /** 1–6. */
  level: number;
  /** Raw text after the marker (`line.text.slice(contentFrom - from)`). */
  text: string;
}

export interface DocModel {
  lines: LineInfo[];
  voids: VoidRange[];
  /** Document headings in order. `patchScan` REUSES the previous model's array
   *  (by reference) when the headings are unchanged, so consumers can
   *  short-circuit with a `===` check. */
  headings: ReadonlyArray<DocHeading>;
}

/** Count of leading whitespace characters (space or tab). Distinct from
 *  `leadingIndent`, which counts columns (tab = 4) — offsets need chars. */
function leadingWsChars(text: string): number {
  let n = 0;
  while (n < text.length && (text[n] === " " || text[n] === "\t")) n++;
  return n;
}

/** Deepest nesting level with dedicated rendering (per-level CSS classes,
 *  hidden-indent math). Deeper indentation renders its whitespace literally. */
export const MAX_NEST = 8;

/** Leading whitespace chars covering `min(level, MAX_NEST) * 2` indent columns
 *  (tab = 4 columns). This is the exact prefix the renderer hides behind the
 *  24px column grid and the atom the caret jumps over — both sides must use
 *  this one function so they can't drift. An odd remainder space (or anything
 *  past MAX_NEST) is NOT counted: it stays visible as literal text. */
export function hiddenIndentChars(info: LineInfo): number {
  const target = Math.min(info.level, MAX_NEST) * 2;
  let cols = 0;
  let n = 0;
  while (n < info.indentChars && cols < target) {
    cols += info.text[n] === "\t" ? 4 : 1;
    n++;
  }
  return n;
}

/** Classify one non-void line. `text` is the raw line; `from` its start offset. */
function classifyLine(text: string, from: number): LineInfo {
  const indentChars = leadingWsChars(text);
  const indent = leadingIndent(text);
  const markerFrom = from + indentChars;
  const to = from + text.length;
  const stripped = text.slice(indentChars);
  const base = {
    number: 0, // filled by caller
    from,
    to,
    text,
    indent,
    indentChars,
    level: Math.floor(indent / 2),
    markerFrom,
  };

  if (stripped === "") return { ...base, role: "blank", contentFrom: markerFrom };
  if (RE.divider.test(stripped)) return { ...base, role: "divider", contentFrom: markerFrom };

  // Heading before lists (a heading is never a list marker); matches textToBlock.
  const h = stripped.match(RE.h);
  if (h) {
    const content = h[2] ?? "";
    return { ...base, role: (`h${h[1]!.length}` as LineRole), contentFrom: to - content.length };
  }

  // Lists via the shared STRICT grammar (blocks.ts matchListLine) — the exact
  // predicate the save parser uses, so the on-screen role can never disagree
  // with what a save/reload (or the share page) produces. Strict = the marker
  // needs trailing whitespace: a bare `-` / `1.` (mid-typing, before the space)
  // and `-foo` / `2.foo` are paragraphs on every surface; `- ` / `1. ` (the
  // serializer's empty-item form) are list items.
  const ll = matchListLine(text, 0);
  if (ll) {
    const contentFrom = to - ll.content.length;
    if (ll.type === "todo") return { ...base, role: "todo", contentFrom, checked: !!ll.checked };
    if (ll.type === "numbered") {
      const numChars = stripped.match(/^\d+/)?.[0].length ?? String(ll.num ?? 1).length;
      return { ...base, role: "numbered", contentFrom, num: ll.num, numChars };
    }
    return { ...base, role: "bullet", contentFrom };
  }

  // Quote via the same shared strict rule (blocks.ts matchQuoteLine): `> x` and
  // `> ` (an empty quote line — what the serializer emits) are quotes; a bare
  // `>` (mid-typing, before the space commits it) and `>foo` are paragraphs.
  // Single grammar source, no editor-local fork.
  const q = matchQuoteLine(stripped);
  if (q !== null) {
    return { ...base, role: "quote", contentFrom: to - q.length };
  }

  return { ...base, role: "p", contentFrom: markerFrom };
}

/** A `void` line entry — a line inside a block embed's source range. */
function voidLine(number: number, from: number, to: number, text: string): LineInfo {
  const indent = leadingIndent(text);
  const indentChars = leadingWsChars(text);
  return {
    number,
    from,
    to,
    text,
    role: "void",
    indent,
    indentChars,
    level: Math.floor(indent / 2),
    markerFrom: from,
    contentFrom: from,
  };
}

/** Line accessor shared by scanDoc (over a split string) and patchScan (over a
 *  CM `Text` / test adapter). 1-based `n`; `to` excludes the trailing newline. */
type LineGetter = (n: number) => { from: number; to: number; text: string };

/**
 * The ONE scan loop, shared by the full scan and the incremental rescan. Scans
 * lines [start..end] (1-based, inclusive) through `line`. Multi-line constructs
 * do not stop at `end`: a fence opener looks forward for its close and a table
 * consumes rows up to `lineCount`; when a construct runs past `end`, `end` is
 * raised to `growEnd(lastConsumedLine)` (≥ that line — patchScan uses this to
 * also swallow any old void the construct ran into) and scanning continues.
 * Returns exactly one LineInfo per consumed line, plus the voids and final end.
 */
function scanRegion(
  line: LineGetter,
  start: number,
  end: number,
  lineCount: number,
  growEnd: (consumedTo: number) => number,
): { lines: LineInfo[]; voids: VoidRange[]; end: number } {
  const lines: LineInfo[] = [];
  const voids: VoidRange[] = [];

  let i = start;
  while (i <= end) {
    const cur = line(i);
    const text = cur.text;
    const indentCols = leadingIndent(text);
    const stripped = stripIndent(text, indentCols);

    // 1) Fenced code / html — a block-level void only when a matching close fence
    //    is found. An UNCLOSED fence is prose (matches parseCodeBlock bailing to a
    //    paragraph), so typing ``` doesn't swallow the rest of the document.
    const fence = stripped.match(RE.fenceOpen);
    if (fence) {
      const ch = fence[1]![0]!;
      const len = fence[1]!.length;
      let close = -1;
      for (let j = i + 1; j <= lineCount; j++) {
        if (isFenceClose(stripIndent(line(j).text, indentCols), ch, len)) {
          close = j;
          break;
        }
      }
      if (close >= 0) {
        const parts: string[] = [];
        for (let m = i; m <= close; m++) parts.push(line(m).text);
        const draft = textToBlock(parts.join("\n"));
        const block = makeBlock(draft.type, draft);
        const lang = cleanLang(fence[2] ?? "");
        const kind: VoidKind = lang === HTML_FENCE || draft.type === "html" ? "html" : "code";
        voids.push({ from: cur.from, to: line(close).to, fromLine: i, toLine: close, kind, block });
        for (let m = i; m <= close; m++) {
          const l = line(m);
          lines.push(voidLine(m, l.from, l.to, l.text));
        }
        if (close > end) end = growEnd(close);
        i = close + 1;
        continue;
      }
      // unclosed → fall through to per-line classification (paragraph)
    }

    // 2) GFM pipe table — header + delimiter row + body rows. The candidate-row
    //    gather condition (non-blank AND contains "|") is a superset of what
    //    parseTableBlock consumes, so it stops itself at the exact same row the
    //    full-array form would.
    if (i < lineCount && stripped.includes("|")) {
      const tArr: string[] = [text, line(i + 1).text];
      if (looksLikeTableAt(tArr, 0, indentCols)) {
        for (let k = i + 2; k <= lineCount; k++) {
          const t = line(k).text;
          if (t.trim() === "" || !t.includes("|")) break;
          tArr.push(t);
        }
        const parsed = parseTableBlock(tArr, 0, indentCols);
        if (parsed) {
          const last = i + parsed.next - 1;
          voids.push({ from: cur.from, to: line(last).to, fromLine: i, toLine: last, kind: "table", block: parsed.block });
          for (let m = i; m <= last; m++) {
            const l = line(m);
            lines.push(voidLine(m, l.from, l.to, l.text));
          }
          if (last > end) end = growEnd(last);
          i = last + 1;
          continue;
        }
      }
    }

    // 3) Single-line media embed (`![](url)` / `[name](/blob/..)`).
    const media = matchMediaLine(stripped);
    if (media) {
      const block = makeBlock(media.type, media);
      voids.push({ from: cur.from, to: cur.to, fromLine: i, toLine: i, kind: media.type as VoidKind, block });
      lines.push(voidLine(i, cur.from, cur.to, text));
      i++;
      continue;
    }

    // 4) Prose / structural line.
    const info = classifyLine(text, cur.from);
    info.number = i;
    lines.push(info);
    i++;
  }

  return { lines, voids, end };
}

/** Extract the h1–h6 lines. Cheap O(lines): a role check plus a slice of the
 *  already-held line text — no regex, no doc access. */
function extractHeadings(lines: LineInfo[]): DocHeading[] {
  const out: DocHeading[] = [];
  for (const l of lines) {
    const r = l.role;
    if (r.length === 2 && r.charCodeAt(0) === 104 /* "h" */) {
      out.push({ from: l.from, level: r.charCodeAt(1) - 48, text: l.text.slice(l.contentFrom - l.from) });
    }
  }
  return out;
}

function sameHeadings(a: DocHeading[], b: ReadonlyArray<DocHeading>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.from !== y.from || x.level !== y.level || x.text !== y.text) return false;
  }
  return true;
}

/**
 * Scan the whole document text into an offset-bearing block model. `src` must use
 * `\n` line breaks (the editor normalizes CRLF on load), so char offsets match CM
 * line offsets exactly. O(lines); fine to run on load — per-keystroke updates go
 * through `patchScan` instead.
 */
export function scanDoc(src: string): DocModel {
  const arr = src.split("\n");
  const froms: number[] = new Array(arr.length);
  {
    let off = 0;
    for (let i = 0; i < arr.length; i++) {
      froms[i] = off;
      off += arr[i]!.length + 1; // + newline
    }
  }
  const line: LineGetter = (n) => ({ from: froms[n - 1]!, to: froms[n - 1]! + arr[n - 1]!.length, text: arr[n - 1]! });
  const region = scanRegion(line, 1, arr.length, arr.length, (n) => n);

  // Defensive: line count must equal document line count (every branch pushes
  // exactly one entry per consumed line). If it ever diverges, fall back to a
  // pure per-line classification so decorations still map 1:1 to lines.
  const ok = region.lines.length === arr.length;
  const lines = ok ? region.lines : fallbackLines(arr, froms);
  const voids = ok ? region.voids : [];
  return { lines, voids, headings: extractHeadings(lines) };
}

// ---- incremental rescan --------------------------------------------------

/** Minimal read view of the NEW document. A CM `Text` satisfies it structurally
 *  (`{ lineCount: doc.lines, length: doc.length, line: (n) => doc.line(n) }`);
 *  tests adapt a plain string. */
export interface LineSource {
  readonly lineCount: number;
  line(n: number): { from: number; to: number; text: string };
  readonly length: number;
}

/** One replaced span of a change set, in CM `ChangeSet.iterChanges` form:
 *  [fromA, toA] in the OLD doc was replaced by [fromB, toB] in the NEW doc.
 *  Spans must be ascending and non-overlapping (what iterChanges yields). */
export interface Edit {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

/** Times patchScan bailed to a full rescan (safety valve; test-visible so the
 *  equivalence suite can assert the incremental path actually ran). */
export let patchScanFallbacks = 0;

function fullRescan(src: LineSource): DocModel {
  patchScanFallbacks++;
  const parts: string[] = [];
  for (let n = 1; n <= src.lineCount; n++) parts.push(src.line(n).text);
  return scanDoc(parts.join("\n"));
}

/** 1-based line number containing char offset `pos` (a line owns [from, to],
 *  `to` = its newline position). Binary search over the model's lines. */
function lineNumAt(lines: LineInfo[], pos: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid]!.from <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Incrementally update `prev` (the model of the OLD document) for `edits`
 * (OLD→NEW change spans) against `src` (the NEW document). Produces the same
 * model `scanDoc(newText)` would (block ids aside), but only re-parses a damage
 * window around the edits:
 *
 *   1. take the edits' char hull in OLD space, widened over every old void it
 *      touches (so a damaged fence/table is rescanned from its first line);
 *   2. translate to a NEW-space line window [ls..le] — lines before the first
 *      edit keep identical numbering, lines after the last shift by lineDelta;
 *   3. widen: pull in adjacent pipe-bearing lines (a table can absorb its
 *      neighbours) and never let a window edge rest inside an old void; if the
 *      window contains a fence-ish line, extend up to the topmost unmatched
 *      fence opener above (it may now pair with a close inside the window);
 *   4. rescan [ls..le] with the SAME loop as scanDoc (fences/tables may consume
 *      past le — le grows with them, swallowing any old void they run into);
 *   5. splice: lines/voids before ls are reused by reference, the window is
 *      replaced, lines/voids after le are shallow-copied with their offsets
 *      shifted; then the cheap global passes (display numbers, headings) run
 *      over the spliced array.
 *
 * Any post-splice inconsistency (count/length mismatch) falls back to a full
 * scanDoc of the new text.
 */
export function patchScan(prev: DocModel, edits: Edit[], src: LineSource): DocModel {
  if (edits.length === 0) return prev;
  const prevLines = prev.lines;
  const prevCount = prevLines.length;
  if (prevCount === 0) return fullRescan(src);
  const prevLen = prevLines[prevCount - 1]!.to;
  const lineDelta = src.lineCount - prevCount;
  const charDelta = src.length - prevLen;

  // 1) Damage hull in OLD char space, widened over intersecting old voids
  //    (endpoint-inclusive, matching voidAt). Voids are disjoint and sorted, so
  //    one forward pass also handles downward chaining.
  let startA = edits[0]!.fromA;
  let endA = edits[edits.length - 1]!.toA;
  for (const v of prev.voids) {
    if (v.from <= endA && v.to >= startA) {
      if (v.from < startA) startA = v.from;
      if (v.to > endA) endA = v.to;
    }
  }
  if (startA < 0 || endA > prevLen) return fullRescan(src);

  // 2) NEW-space line window. Lines before the first edit are byte-identical
  //    with identical numbering, so `ls` transfers from OLD space directly; the
  //    window end sits at/after the last edit, so it shifts by lineDelta.
  let ls = lineNumAt(prevLines, startA);
  let le = lineNumAt(prevLines, endA) + lineDelta;
  if (le < ls || le > src.lineCount) return fullRescan(src);

  // Old-void line spans translated into NEW space. Above the window all voids
  // keep identity numbering; below it they shift by lineDelta. Applying the
  // wrong translation to a void on the other side can only over-widen (the
  // window grows — never misclassifies), and each pass ends on a real void
  // boundary, so a window edge never rests strictly inside a kept void.
  const voidStartAtOrBefore = (n: number): number => {
    let x = n;
    for (let k = prev.voids.length - 1; k >= 0; k--) {
      const v = prev.voids[k]!;
      if (v.fromLine < x && v.toLine >= x) x = v.fromLine;
    }
    return x;
  };
  const voidEndAtOrAfter = (n: number): number => {
    let x = n;
    for (const v of prev.voids) {
      const f = v.fromLine + lineDelta;
      const t = v.toLine + lineDelta;
      if (f <= x && t > x) x = t;
    }
    return x;
  };

  // 3) Widening fixpoint. Pipe-bearing neighbours can be absorbed into a table
  //    that forms/extends inside the window; a window edge inside an old void
  //    must swallow the void whole.
  const widenUp = () => {
    for (;;) {
      let a = voidStartAtOrBefore(ls);
      while (a > 1 && src.line(a - 1).text.includes("|")) a--;
      a = voidStartAtOrBefore(a);
      if (a === ls) return;
      ls = a;
    }
  };
  widenUp();
  for (;;) {
    let b = voidEndAtOrAfter(le);
    while (b < src.lineCount && src.line(b + 1).text.includes("|")) b++;
    b = voidEndAtOrAfter(b);
    if (b === le) break;
    le = b;
  }

  // 4) Fence pairing across the window top. A fence-ish line in the NEW window
  //    can close a previously-UNMATCHED opener above it (an unmatched opener is
  //    prose, so it is invisible to the void widening). Unmatched means no
  //    matching close existed ANYWHERE below it in the old doc — so only new
  //    window text can change its pairing, and only when the window contains a
  //    fence-ish line at all. Rare (the user typed/removed a ``` line): scan the
  //    prefix for the topmost non-void fence-ish line and rescan from there.
  let fencish = false;
  for (let n = ls; n <= le; n++) {
    if (RE.fenceOpen.test(src.line(n).text)) {
      fencish = true;
      break;
    }
  }
  if (fencish) {
    for (let n = 1; n < ls; n++) {
      const l = prevLines[n - 1]!;
      if (l.role !== "void" && RE.fenceOpen.test(l.text)) {
        ls = n;
        widenUp();
        break;
      }
    }
  }

  // 5) Rescan the window with the shared loop. When a fence/table consumes past
  //    le, growEnd extends le over any old void the construct landed in, so the
  //    remainder of that void is rescanned too instead of dangling.
  const region = scanRegion((n) => src.line(n), ls, le, src.lineCount, voidEndAtOrAfter);
  le = region.end;
  const leA = le - lineDelta; // last damaged line in OLD numbering

  // 6) Splice lines: prefix reused by reference (offsets/numbering untouched),
  //    suffix shallow-copied with every absolute offset shifted
  //    (from/to/markerFrom/contentFrom).
  const lines: LineInfo[] = prevLines.slice(0, ls - 1);
  for (const l of region.lines) lines.push(l);
  for (let k = leA; k < prevCount; k++) {
    const l = prevLines[k]!;
    lines.push({
      ...l,
      number: l.number + lineDelta,
      from: l.from + charDelta,
      to: l.to + charDelta,
      markerFrom: l.markerFrom + charDelta,
      contentFrom: l.contentFrom + charDelta,
    });
  }
  if (lines.length !== src.lineCount || lines[lines.length - 1]!.to !== src.length) {
    return fullRescan(src);
  }

  // Same 3-way splice for voids (window voids were re-created by the rescan;
  // no kept void straddles a window edge — see widening).
  const voids: VoidRange[] = [];
  for (const v of prev.voids) {
    if (v.toLine >= ls) break;
    voids.push(v);
  }
  for (const v of region.voids) voids.push(v);
  for (const v of prev.voids) {
    if (v.fromLine > leA) {
      voids.push({
        ...v,
        from: v.from + charDelta,
        to: v.to + charDelta,
        fromLine: v.fromLine + lineDelta,
        toLine: v.toLine + lineDelta,
      });
    }
  }

  // Global cheap pass: headings feed the === contract.
  const headings = extractHeadings(lines);
  return {
    lines,
    voids,
    headings: sameHeadings(headings, prev.headings) ? prev.headings : headings,
  };
}


/** Last-resort per-line classification with no void detection (see scanDoc tail). */
function fallbackLines(arr: string[], froms: number[]): LineInfo[] {
  return arr.map((text, i) => {
    const info = classifyLine(text, froms[i]!);
    info.number = i + 1;
    return info;
  });
}

/** Find the void whose source range contains (or touches) `pos`, or null. Used by
 *  the reveal predicate and by structure keys that must treat a void as a unit. */
export function voidAt(model: DocModel, pos: number): VoidRange | null {
  for (const v of model.voids) if (pos >= v.from && pos <= v.to) return v;
  return null;
}

/** True if the offset lies within any void's source range (endpoints inclusive).
 *  The inline tokenizer uses this to leave code/html source literal. */
export function insideVoid(model: DocModel, pos: number): boolean {
  return voidAt(model, pos) !== null;
}
