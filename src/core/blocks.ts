// Pure markdown <-> block conversion and diffing. A document body is a sequence
// of blocks separated by blank lines; fenced code blocks (``` / ~~~) are kept
// whole so their internal blank lines don't split them. No DB dependency.

/**
 * A document block plus the blank lines the user left after it. `blankAfter` is
 * the count *beyond* the standard single-blank-line separator (so a normal
 * paragraph break is 0); for the last block it's the trailing blank-line run.
 * This is what lets deliberate vertical spacing survive a save/reload without
 * representing blank lines as zero-content blocks (which would churn the
 * text-keyed reconcile). See [[blocks]] doc-block model.
 */
export interface DocBlock {
  text: string;
  blankAfter: number;
}

/**
 * Split markdown into doc blocks, preserving blank-line runs as `blankAfter`.
 * Leading blank lines (before the first block) are dropped; one blank line
 * between two blocks is the standard separator, every extra blank line is kept.
 */
export function parseDocBlocks(md: string): DocBlock[] {
  if (!md) return [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: DocBlock[] = [];
  let cur: string[] = [];
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;

  const closeBlock = () => {
    if (cur.length) {
      blocks.push({ text: cur.join("\n"), blankAfter: 0 });
      cur = [];
    }
  };
  const onBlank = () => {
    closeBlock();
    // Count toward the preceding block; a blank line before any block (leading
    // whitespace) has nowhere to attach and is dropped.
    if (blocks.length) blocks[blocks.length - 1]!.blankAfter++;
  };

  for (const raw of lines) {
    if (fenceChar) {
      cur.push(raw);
      const m = raw.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (m && m[1]![0] === fenceChar && m[1]!.length >= fenceLen) {
        closeBlock();
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }
    const open = raw.match(/^\s*(`{3,}|~{3,})/);
    if (open) {
      closeBlock();
      fenceChar = open[1]![0] as "`" | "~";
      fenceLen = open[1]!.length;
      cur.push(raw);
    } else if (raw.trim() === "") {
      onBlank();
    } else {
      cur.push(raw);
    }
  }
  closeBlock(); // trailing paragraph or unterminated fence

  // Convert raw blank-line counts to "extra beyond the standard separator". The
  // last block keeps its raw count (trailing blanks have no following separator).
  for (let i = 0; i < blocks.length - 1; i++)
    blocks[i]!.blankAfter = Math.max(0, blocks[i]!.blankAfter - 1);
  return blocks;
}

/** Serialize doc blocks back to a body, re-emitting kept blank-line runs. */
export function serializeDocBlocks(
  blocks: readonly { text: string | null; blankAfter?: number }[],
): string {
  const live = blocks.filter((b): b is { text: string; blankAfter?: number } => !!b.text && b.text.length > 0);
  const out: string[] = [];
  live.forEach((b, i) => {
    out.push(...b.text.split("\n"));
    const extra = Math.max(0, b.blankAfter ?? 0);
    if (i < live.length - 1) out.push(""); // standard single-blank-line separator
    for (let k = 0; k < extra; k++) out.push("");
  });
  return out.join("\n");
}

export type ReconcileItem = { keep: number } | { insert: string };
export interface ReconcilePlan {
  /** The new block sequence, each item either reusing an old block or inserting text. */
  items: ReconcileItem[];
  /** Old block indices that are no longer present. */
  deleted: number[];
}

/**
 * Align a new sequence of block texts against the old one. Unchanged blocks
 * (exact text match, in order — the LCS) are kept by index so their identity and
 * order survive; everything else in a gap is a delete (old) or insert (new).
 */
export function reconcile(oldTexts: string[], newTexts: string[]): ReconcilePlan {
  const keep = lcs(oldTexts, newTexts);
  const keptOld = new Set(keep.map((p) => p[0]));
  const newToOld = new Map(keep.map((p) => [p[1], p[0]]));

  const items: ReconcileItem[] = newTexts.map((text, ni) =>
    newToOld.has(ni) ? { keep: newToOld.get(ni)! } : { insert: text },
  );
  const deleted: number[] = [];
  for (let oi = 0; oi < oldTexts.length; oi++)
    if (!keptOld.has(oi)) deleted.push(oi);

  return { items, deleted };
}

/** Longest common subsequence as aligned (oldIndex, newIndex) pairs. */
function lcs(a: string[], b: string[]): [number, number][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);

  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}
