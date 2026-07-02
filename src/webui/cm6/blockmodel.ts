// Offset-bearing block scanner for the single-document CM6 editor.
//
// The editor's document IS the raw Markdown body; "blocks" are a derived
// presentation layer. This module turns the current document text into a flat,
// offset-indexed model that drives every decoration, void widget, and structure
// key: `scanDoc(src)` walks the lines once and returns
//   • `lines[]` — one entry per document line with its role + the char offsets a
//     decoration needs (leading-indent range, marker range, content start), and
//   • `voids[]`  — the source ranges of block-level embeds (fenced code / html,
//     GFM tables, single-line media) with their parsed `Block` for the widget.
//
// It reuses the line grammar from `blocks.ts` (the SAME predicates the save path
// parses with) so the on-screen model can never drift from what a save/reload
// produces. It is intentionally CM-free (operates on a string) so it is trivially
// unit-testable; `region-field.ts` adapts a CM `Text` to it via `doc.toString()`.
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
  /** numbered: the literal number the user typed (kept as editable text). */
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

export interface DocModel {
  lines: LineInfo[];
  voids: VoidRange[];
}

/** Count of leading whitespace characters (space or tab). Distinct from
 *  `leadingIndent`, which counts columns (tab = 4) — offsets need chars. */
function leadingWsChars(text: string): number {
  let n = 0;
  while (n < text.length && (text[n] === " " || text[n] === "\t")) n++;
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

  // Lists via the shared grammar helper (todo / numbered / bullet) — no drift.
  // BUT require a space after the marker to RENDER as a list: a bare `-` / `1.`
  // (marker only, no trailing space) stays a paragraph while typing, only becoming
  // a list once the space is typed (Notion/main rule). `matchListLine` itself stays
  // lenient (shared block parser + defensive empty-item round-trip); this stricter
  // gate is CM6-render-only. A `todo` marker always carries `[...]`, so the bare
  // test never rejects it; `- `/`1. ` (with the space) are unaffected.
  const bareMarker = /^([-*+]|\d+[.)])$/.test(stripped);
  const ll = bareMarker ? null : matchListLine(text, 0);
  if (ll) {
    const contentFrom = to - ll.content.length;
    if (ll.type === "todo") return { ...base, role: "todo", contentFrom, checked: !!ll.checked };
    if (ll.type === "numbered") {
      const numChars = stripped.match(/^\d+/)?.[0].length ?? String(ll.num ?? 1).length;
      return { ...base, role: "numbered", contentFrom, num: ll.num, numChars };
    }
    return { ...base, role: "bullet", contentFrom };
  }

  // Quote likewise requires `> ` (a space/tab after `>`) — a bare `>` stays a
  // paragraph until the space, matching the list rule and main's transform. Uses a
  // local pattern (not the lenient shared RE.quote, which the main block parser
  // still relies on for `>text`).
  const q = stripped.match(/^>[ \t](.*)$/);
  if (q) {
    const content = q[1] ?? "";
    return { ...base, role: "quote", contentFrom: to - content.length };
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

/**
 * Scan the whole document text into an offset-bearing block model. `src` must use
 * `\n` line breaks (the editor normalizes CRLF on load), so char offsets match CM
 * line offsets exactly. O(lines); safe to run on every doc change.
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

  const lines: LineInfo[] = [];
  const voids: VoidRange[] = [];

  let i = 0;
  while (i < arr.length) {
    const text = arr[i]!;
    const from = froms[i]!;
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
      for (let j = i + 1; j < arr.length; j++) {
        if (isFenceClose(stripIndent(arr[j]!, indentCols), ch, len)) {
          close = j;
          break;
        }
      }
      if (close >= 0) {
        const source = arr.slice(i, close + 1).join("\n");
        const draft = textToBlock(source);
        const block = makeBlock(draft.type, draft);
        const lang = cleanLang(fence[2] ?? "");
        const kind: VoidKind = lang === HTML_FENCE || draft.type === "html" ? "html" : "code";
        const to = froms[close]! + arr[close]!.length;
        voids.push({ from, to, fromLine: i + 1, toLine: close + 1, kind, block });
        for (let m = i; m <= close; m++)
          lines.push(voidLine(m + 1, froms[m]!, froms[m]! + arr[m]!.length, arr[m]!));
        i = close + 1;
        continue;
      }
      // unclosed → fall through to per-line classification (paragraph)
    }

    // 2) GFM pipe table — header + delimiter row + body rows.
    if (looksLikeTableAt(arr, i, indentCols)) {
      const parsed = parseTableBlock(arr, i, indentCols);
      if (parsed) {
        const last = parsed.next - 1;
        const to = froms[last]! + arr[last]!.length;
        voids.push({ from, to, fromLine: i + 1, toLine: last + 1, kind: "table", block: parsed.block });
        for (let m = i; m <= last; m++)
          lines.push(voidLine(m + 1, froms[m]!, froms[m]! + arr[m]!.length, arr[m]!));
        i = parsed.next;
        continue;
      }
    }

    // 3) Single-line media embed (`![](url)` / `[name](/blob/..)`).
    const media = matchMediaLine(stripped);
    if (media) {
      const block = makeBlock(media.type, media);
      const to = from + text.length;
      voids.push({ from, to, fromLine: i + 1, toLine: i + 1, kind: media.type as VoidKind, block });
      lines.push(voidLine(i + 1, from, to, text));
      i++;
      continue;
    }

    // 4) Prose / structural line.
    const info = classifyLine(text, from);
    info.number = i + 1;
    lines.push(info);
    i++;
  }

  // Defensive: line count must equal document line count (every branch pushes
  // exactly one entry per consumed line). If it ever diverges, fall back to a
  // pure per-line classification so decorations still map 1:1 to lines.
  return lines.length === arr.length
    ? { lines, voids }
    : { lines: fallbackLines(arr, froms), voids: [] };
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
