// Pure markdown <-> block conversion and diffing. A document body is a sequence
// of blocks separated by blank lines; fenced code blocks (``` / ~~~) are kept
// whole so their internal blank lines don't split them. No DB dependency.

/** Split markdown into block texts (no leading/trailing blank lines, no empties). */
export function parseBlocks(md: string): string[] {
  if (!md) return [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;

  const flushPara = () => {
    while (cur.length && cur[cur.length - 1]!.trim() === "") cur.pop();
    while (cur.length && cur[0]!.trim() === "") cur.shift();
    if (cur.length) blocks.push(cur.join("\n"));
    cur = [];
  };

  for (const raw of lines) {
    if (fenceChar) {
      cur.push(raw);
      const m = raw.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (m && m[1]![0] === fenceChar && m[1]!.length >= fenceLen) {
        blocks.push(cur.join("\n"));
        cur = [];
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }
    const open = raw.match(/^\s*(`{3,}|~{3,})/);
    if (open) {
      flushPara();
      fenceChar = open[1]![0] as "`" | "~";
      fenceLen = open[1]!.length;
      cur.push(raw);
    } else if (raw.trim() === "") {
      flushPara();
    } else {
      cur.push(raw);
    }
  }
  // EOF: close out a trailing paragraph or an unterminated fence.
  if (fenceChar) {
    if (cur.length) blocks.push(cur.join("\n"));
  } else {
    flushPara();
  }
  return blocks;
}

/** Join block texts back into a markdown body. */
export function serializeBlocks(texts: readonly (string | null)[]): string {
  return texts.filter((t): t is string => !!t && t.length > 0).join("\n\n");
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
