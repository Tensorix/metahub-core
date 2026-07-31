// Pure display-side helpers for the version history UI: GitHub-style line
// diffing, the rendered rich-text diff, and the timeline (date groups +
// minor-edit clustering). No DOM, no api — unit tested by hist-diff.test.ts.

import { parseDocBlocks } from "../core/blocks.ts";
import type { DocRevision } from "../core/history.ts";
import { addDays, sameDay, startOfWeekMon, today } from "./date.ts";

// ---- line diff (source mode) -------------------------------------------------

/** Longest common subsequence pairs — same alignment rule the core reconcile uses. */
export function lcs(a: string[], b: string[]): [number, number][] {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

export type DiffLine = {
  kind: "same" | "add" | "del";
  text: string;
  /** 1-based line number in the base (same/del rows). */
  oldNo?: number;
  /** 1-based line number in the target (same/add rows). */
  newNo?: number;
  /** Intra-line emphasis: [unchanged prefix, changed middle, unchanged suffix]. */
  seg?: [string, string, string];
  /** Line sits inside a fenced code block — render monospaced; prose lines
   *  render in the document's body font so the diff reads like the document. */
  mono?: boolean;
};

/** Per-line "inside a fenced code block" flags (fence markers included).
 *  Same fence tracking as core's parseDocBlocks: an unterminated opener runs
 *  to EOF — for diff styling that beats flipping the whole tail to prose. */
function codeLineFlags(lines: string[]): boolean[] {
  const flags = new Array<boolean>(lines.length).fill(false);
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  lines.forEach((raw, i) => {
    if (fenceChar) {
      flags[i] = true;
      const m = raw.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (m && m[1]![0] === fenceChar && m[1]!.length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
      return;
    }
    const open = raw.match(/^\s*(`{3,}|~{3,})/);
    if (open) {
      flags[i] = true;
      fenceChar = open[1]![0] as "`" | "~";
      fenceLen = open[1]!.length;
    }
  });
  return flags;
}

/**
 * GitHub-style intra-line marks: the i-th deleted line in a gap pairs with the
 * i-th added line; stripping their common prefix/suffix leaves the middle that
 * actually changed. Lines that share too little read as a rewrite, not an
 * in-place edit — no marks for those (a fully-dark line is just noise).
 */
function markSegments(dels: DiffLine[], adds: DiffLine[]): void {
  for (let i = 0; i < Math.min(dels.length, adds.length); i++) {
    const o = dels[i]!.text;
    const n = adds[i]!.text;
    let p = 0;
    while (p < o.length && p < n.length && o[p] === n[p]) p++;
    let s = 0;
    while (s < o.length - p && s < n.length - p && o[o.length - 1 - s] === n[n.length - 1 - s]) s++;
    if (p + s < Math.max(o.length, n.length) * 0.3) continue;
    dels[i]!.seg = [o.slice(0, p), o.slice(p, o.length - s), o.slice(o.length - s)];
    adds[i]!.seg = [n.slice(0, p), n.slice(p, n.length - s), n.slice(n.length - s)];
  }
}

/** base → target as a git-style unified diff over ALL lines (blank lines
 *  included — line numbers must stay true to the source). */
export function diffLines(base: string, target: string): DiffLine[] {
  const a = base ? base.replace(/\r\n?/g, "\n").split("\n") : [];
  const b = target ? target.replace(/\r\n?/g, "\n").split("\n") : [];
  const codeA = codeLineFlags(a);
  const codeB = codeLineFlags(b);
  const keep = lcs(a, b);
  const rows: DiffLine[] = [];
  let ai = 0;
  let bi = 0;
  for (const [ka, kb] of [...keep, [a.length, b.length] as [number, number]]) {
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    for (; ai < ka; ai++)
      dels.push({ kind: "del", text: a[ai]!, oldNo: ai + 1, mono: codeA[ai] || undefined });
    for (; bi < kb; bi++)
      adds.push({ kind: "add", text: b[bi]!, newNo: bi + 1, mono: codeB[bi] || undefined });
    markSegments(dels, adds);
    rows.push(...dels, ...adds);
    if (ka < a.length)
      rows.push({
        kind: "same",
        text: a[ka]!,
        oldNo: ka + 1,
        newNo: kb + 1,
        mono: codeB[kb] || undefined,
      });
    ai = ka + 1;
    bi = kb + 1;
  }
  return rows;
}

export type DiffSection =
  | { kind: "rows"; rows: DiffLine[] }
  /** A run of unchanged lines hidden behind an expander (GitHub's "⋯"). */
  | { kind: "fold"; rows: DiffLine[] };

/**
 * Collapse long unchanged runs, keeping `context` visible lines on each side
 * of a change (GitHub-style hunks). A run only folds when it hides at least
 * `minHidden` lines — a tiny "expand 2 lines" button is worse than the lines.
 */
export function foldSame(rows: DiffLine[], context = 3, minHidden = 5): DiffSection[] {
  const out: DiffSection[] = [];
  let i = 0;
  const push = (kind: "rows" | "fold", rows_: DiffLine[]) => {
    if (!rows_.length) return;
    const last = out[out.length - 1];
    if (kind === "rows" && last?.kind === "rows") last.rows.push(...rows_);
    else out.push({ kind, rows: rows_ });
  };
  while (i < rows.length) {
    if (rows[i]!.kind !== "same") {
      push("rows", [rows[i]!]);
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j]!.kind === "same") j++;
    const run = rows.slice(i, j);
    // Edge runs only need context on their inner side.
    const lead = i === 0 ? 0 : context;
    const trail = j === rows.length ? 0 : context;
    if (run.length - lead - trail >= minHidden) {
      push("rows", run.slice(0, lead));
      push("fold", run.slice(lead, run.length - trail));
      push("rows", trail ? run.slice(run.length - trail) : []);
    } else {
      push("rows", run);
    }
    i = j;
  }
  return out;
}

// ---- rich-text diff (rendered "changes" mode) --------------------------------

/** One renderable stretch of the rich diff. `fold` sections hold unchanged
 *  blocks hidden behind an expander; `blocks` is how many they hide. */
export type RichSection = { kind: "rows" | "fold"; html: string; blocks: number };

// Private-use sentinels wrapped around changed word runs BEFORE rendering,
// swapped for <del>/<ins> AFTER — inline markers stay intact for the markdown
// tokenizer, unlike injecting real tags into the source.
const DEL_O = "\uE000";
const DEL_C = "\uE001";
const ADD_O = "\uE002";
const ADD_C = "\uE003";
const SENTINELS = /[\uE000-\uE003]/g;

/** Word-level diff units: whitespace runs; CJK ideographs/kana and CJK or
 *  fullwidth punctuation per character; latin/digit words as runs; anything
 *  else (ASCII punctuation, symbols) per character. Punctuation being its own
 *  token is what keeps 全角标点相邻词 from reading as one giant changed word —
 *  only the word that actually changed gets marked. */
const wordTokens = (s: string): string[] =>
  s.match(/\s+|[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]|[a-zA-Z0-9_]+|./g) ?? [];

/** Merge old→new at word level with sentinel-wrapped del/ins runs. */
function mergeWords(oldText: string, newText: string): { merged: string; dels: number; adds: number } {
  const a = wordTokens(oldText);
  const b = wordTokens(newText);
  const keep = lcs(a, b);
  let merged = "";
  let dels = 0;
  let adds = 0;
  let ai = 0;
  let bi = 0;
  for (const [ka, kb] of [...keep, [a.length, b.length] as [number, number]]) {
    const del = a.slice(ai, ka).join("");
    const add = b.slice(bi, kb).join("");
    // A deleted pure-whitespace run is invisible — dropping the mark beats a
    // struck-through blank; added whitespace flows in unmarked.
    if (del && del.trim()) {
      merged += DEL_O + del + DEL_C;
      dels++;
    }
    if (add) {
      if (add.trim()) {
        merged += ADD_O + add + ADD_C;
        adds++;
      } else merged += add;
    }
    if (ka < a.length) merged += a[ka]!;
    ai = ka + 1;
    bi = kb + 1;
  }
  return { merged, dels, adds };
}

/** Leading block-structure markers: list bullets / ordered numbers (with an
 *  optional todo box), heading hashes, quote arrows — possibly nested. */
const MARKER_RE = /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+|>\s*)+/;
const markerOf = (line: string): string => MARKER_RE.exec(line)?.[0] ?? "";
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;

/**
 * Line-structured sentinel merge of a paired (edited) block. Marks never span
 * a line, so they can never straddle rendered element boundaries (the failure
 * that used to knock a 12-item list back to a stacked whole-block diff when
 * two items were appended). Structure markers stay OUTSIDE the marks so the
 * grammar still recognizes each line; lines align by their marker-stripped
 * text, so inserting one list item doesn't flag every renumbered neighbour —
 * they silently adopt their new number. Returns null for table blocks: a
 * wrapped row no longer parses as a row, those pairs render stacked.
 */
function mergeBlock(
  oldText: string,
  newText: string,
): { merged: string; dels: number; adds: number } | null {
  if (/^\s*\|/.test(oldText) || /^\s*\|/.test(newText)) return null;
  const fence = FENCE_LINE.test(oldText) || FENCE_LINE.test(newText);
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const strip = (l: string) => (fence ? l : l.slice(markerOf(l).length));
  const keep = lcs(a.map(strip), b.map(strip));
  const out: string[] = [];
  let dels = 0;
  let adds = 0;
  // Whole added/removed line: wrap its content, keep the marker bare. Fence
  // markers / blank / marker-only lines carry structure, not words — unmarked.
  const wrapLine = (line: string, open: string, close: string): string | null => {
    if (!line.trim() || FENCE_LINE.test(line)) return null;
    const m = fence ? "" : markerOf(line);
    const rest = line.slice(m.length);
    if (!rest.trim()) return null;
    return m + open + rest + close;
  };
  let ai = 0;
  let bi = 0;
  for (const [ka, kb] of [...keep, [a.length, b.length] as [number, number]]) {
    const gapA = a.slice(ai, ka);
    const gapB = b.slice(bi, kb);
    const n = Math.min(gapA.length, gapB.length);
    for (let i = 0; i < n; i++) {
      const om = fence ? "" : markerOf(gapA[i]!);
      const nm = fence ? "" : markerOf(gapB[i]!);
      const r = mergeWords(gapA[i]!.slice(om.length), gapB[i]!.slice(nm.length));
      out.push(nm + r.merged);
      dels += r.dels;
      adds += r.adds;
    }
    for (let i = n; i < gapA.length; i++) {
      const w = wrapLine(gapA[i]!, DEL_O, DEL_C);
      if (w != null) dels++;
      out.push(w ?? gapA[i]!);
    }
    for (let i = n; i < gapB.length; i++) {
      const w = wrapLine(gapB[i]!, ADD_O, ADD_C);
      if (w != null) adds++;
      out.push(w ?? gapB[i]!);
    }
    // Same by stripped key — adopt the NEW line (its marker may have changed).
    if (ka < a.length) out.push(b[kb] ?? a[ka]!);
    ai = ka + 1;
    bi = kb + 1;
  }
  return { merged: out.join("\n"), dels, adds };
}

const VOID_TAGS = new Set(["img", "br", "hr", "input", "source", "track", "wbr", "area", "col", "embed"]);

/** True when every sentinel survived rendering as swappable text: right
 *  counts, none inside a tag, and each open/close pair sits at the same tag
 *  depth without ever dipping below it (a dip means the pair straddles an
 *  element boundary — swapping in <del>/<ins> would produce crossed markup,
 *  e.g. a mark that starts inside a link and ends outside it). */
function sentinelsSafe(html: string, dels: number, adds: number): boolean {
  let depth = 0;
  let openDepth: number | null = null; // depth where the current mark opened
  let minDepth = 0;
  const seen = new Map<string, number>();
  let i = 0;
  while (i < html.length) {
    const ch = html[i]!;
    if (ch === "<") {
      const end = html.indexOf(">", i);
      if (end < 0) return false;
      const tag = html.slice(i + 1, end);
      if (SENTINELS.test(tag)) return false;
      SENTINELS.lastIndex = 0;
      const name = /^\/?([a-z0-9]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
      if (tag.startsWith("/")) depth--;
      else if (!tag.endsWith("/") && !VOID_TAGS.has(name)) depth++;
      if (openDepth != null) minDepth = Math.min(minDepth, depth);
      i = end + 1;
      continue;
    }
    if (ch >= DEL_O && ch <= ADD_C) {
      seen.set(ch, (seen.get(ch) ?? 0) + 1);
      if (ch === DEL_O || ch === ADD_O) {
        if (openDepth != null) return false; // marks never nest by construction
        openDepth = depth;
        minDepth = depth;
      } else {
        if (openDepth == null || depth !== openDepth || minDepth < openDepth) return false;
        openDepth = null;
      }
    }
    i++;
  }
  return (
    openDepth == null &&
    (seen.get(DEL_O) ?? 0) === dels &&
    (seen.get(DEL_C) ?? 0) === dels &&
    (seen.get(ADD_O) ?? 0) === adds &&
    (seen.get(ADD_C) ?? 0) === adds
  );
}

const firstTag = (html: string): string => /^\s*<([a-z0-9]+)/i.exec(html)?.[1] ?? "";

const RICH_CONTEXT = 1;
const RICH_MIN_HIDDEN = 3;

/**
 * Rendered diff over fence-aware blocks: unchanged blocks render as the
 * document (long runs folded), added/removed blocks get a green/red wash, and
 * an edited block renders ONCE with word-level <del>/<ins> marks merged in.
 * When the merge would distort rendering (block type changed, marks landed
 * inside a tag/attribute) that pair falls back to old-over-new blocks.
 */
export function richDiffSections(
  base: string,
  target: string,
  render: (md: string) => string,
): RichSection[] {
  const clean = (s: string) => s.replace(SENTINELS, "");
  const a = parseDocBlocks(clean(base)).map((b) => b.text);
  const b = parseDocBlocks(clean(target)).map((b) => b.text);

  const wrap = (cls: string, html: string) => `<div class="rd ${cls}">${html}</div>`;
  const stacked = (oldText: string, newText: string) =>
    wrap("del", render(oldText)) + wrap("add", render(newText));
  const pair = (oldText: string, newText: string): string => {
    const oldHtml = render(oldText);
    const newHtml = render(newText);
    if (firstTag(oldHtml) !== firstTag(newHtml)) return stacked(oldText, newText);
    const mb = mergeBlock(oldText, newText);
    if (!mb) return stacked(oldText, newText);
    const html = render(mb.merged);
    if (firstTag(html) !== firstTag(newHtml) || !sentinelsSafe(html, mb.dels, mb.adds))
      return stacked(oldText, newText);
    return wrap(
      "edit",
      html
        .replaceAll(DEL_O, '<del class="rdx">')
        .replaceAll(DEL_C, "</del>")
        .replaceAll(ADD_O, '<ins class="rdi">')
        .replaceAll(ADD_C, "</ins>"),
    );
  };

  // Block-level walk mirroring diffLines: gaps pair i-th del with i-th add.
  type Row = { same: boolean; html: string };
  const rows: Row[] = [];
  const keep = lcs(a, b);
  let ai = 0;
  let bi = 0;
  for (const [ka, kb] of [...keep, [a.length, b.length] as [number, number]]) {
    const dels = a.slice(ai, ka);
    const adds = b.slice(bi, kb);
    const n = Math.min(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ same: false, html: pair(dels[i]!, adds[i]!) });
    for (let i = n; i < dels.length; i++)
      rows.push({ same: false, html: wrap("del", render(dels[i]!)) });
    for (let i = n; i < adds.length; i++)
      rows.push({ same: false, html: wrap("add", render(adds[i]!)) });
    if (ka < a.length) rows.push({ same: true, html: wrap("same", render(a[ka]!)) });
    ai = ka + 1;
    bi = kb + 1;
  }

  // Fold long unchanged runs, keeping a block of context beside each change.
  const out: RichSection[] = [];
  const push = (kind: "rows" | "fold", slice: Row[]) => {
    if (!slice.length) return;
    const html = slice.map((r) => r.html).join("");
    const last = out[out.length - 1];
    if (kind === "rows" && last?.kind === "rows") {
      last.html += html;
      last.blocks += slice.length;
    } else out.push({ kind, html, blocks: slice.length });
  };
  let i = 0;
  while (i < rows.length) {
    if (!rows[i]!.same) {
      push("rows", [rows[i]!]);
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j]!.same) j++;
    const run = rows.slice(i, j);
    const lead = i === 0 ? 0 : RICH_CONTEXT;
    const trail = j === rows.length ? 0 : RICH_CONTEXT;
    if (run.length - lead - trail >= RICH_MIN_HIDDEN) {
      push("rows", run.slice(0, lead));
      push("fold", run.slice(lead, run.length - trail));
      push("rows", trail ? run.slice(run.length - trail) : []);
    } else {
      push("rows", run);
    }
    i = j;
  }
  return out;
}

// ---- timeline: date groups + minor-edit clustering ---------------------------

export type TimelineEntry =
  | { type: "rev"; rev: DocRevision }
  /** Newest-first run of consecutive minor edits by one device, folded away
   *  until opened. */
  | { type: "cluster"; revs: DocRevision[] };

export interface TimelineGroup {
  label: string;
  entries: TimelineEntry[];
}

/** Date bucket for a revision timestamp: 今天 / 昨天 / 本周, per-day inside the
 *  current month, per-month beyond. */
export function groupLabel(at: string, now: Date = today()): string {
  const d = new Date(at);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (sameDay(day, now)) return "今天";
  if (sameDay(day, addDays(now, -1))) return "昨天";
  if (day >= startOfWeekMon(now) && day < now) return "本周";
  if (day.getFullYear() === now.getFullYear() && day.getMonth() === now.getMonth())
    return `${day.getMonth() + 1}月${day.getDate()}日`;
  return `${day.getFullYear()}年${day.getMonth() + 1}月`;
}

/** A revision small enough to fold into a cluster: a plain user edit touching
 *  at most a couple of blocks (core already clusters keystrokes via txn/1.5s;
 *  this is the UI's second pass over save-sized revisions). */
const isMinor = (r: DocRevision): boolean =>
  r.kind === "user" &&
  !r.created &&
  !r.deleted &&
  !r.title_changed &&
  r.blocks_changed + r.blocks_deleted <= 2;

const CLUSTER_GAP_MS = 10 * 60_000;
/** Runs longer than this fold; shorter runs stay as individual rows. */
const CLUSTER_MIN = 4;

/**
 * Fold `revs` (newest-first, already visibility-filtered) into date groups,
 * clustering consecutive minor edits by the same device with < 10 min between
 * neighbours. The newest revision overall never clusters — the "当前" row must
 * stay visible. Clusters never span date groups.
 */
export function buildDocTimeline(revs: DocRevision[], now: Date = today()): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  let cur: TimelineGroup | null = null;
  let run: DocRevision[] = [];

  const flushRun = () => {
    if (!run.length) return;
    const g = cur!;
    if (run.length >= CLUSTER_MIN) g.entries.push({ type: "cluster", revs: run });
    else for (const r of run) g.entries.push({ type: "rev", rev: r });
    run = [];
  };

  revs.forEach((r, i) => {
    const label = groupLabel(r.at, now);
    if (!cur || cur.label !== label) {
      flushRun();
      cur = { label, entries: [] };
      groups.push(cur);
    }
    const clusterable = i > 0 && isMinor(r);
    if (!clusterable) {
      flushRun();
      cur.entries.push({ type: "rev", rev: r });
      return;
    }
    const prev = run[run.length - 1];
    if (
      prev &&
      (prev.node_id !== r.node_id ||
        new Date(prev.at).getTime() - new Date(r.at).getTime() >= CLUSTER_GAP_MS)
    )
      flushRun();
    run.push(r);
  });
  flushRun();
  return groups;
}
