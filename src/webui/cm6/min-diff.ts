// Minimal single-range replace between two strings (shared prefix/suffix
// shrink). Used by CmDocBody.replaceDoc (remote merges — CM maps the caret
// through the small middle change) and by the void widgets' commit() (per-
// keystroke write-backs — CM history then stores a few characters instead of
// the whole block's before/after text).

export interface MinReplace {
  from: number;
  to: number;
  insert: string;
}

/** The smallest `{from,to,insert}` turning `cur` into `next`, offset by `base`
 *  (the position of `cur` in the document). Null when the strings are equal. */
export function minimalReplace(cur: string, next: string, base = 0): MinReplace | null {
  if (cur === next) return null;
  const max = Math.min(cur.length, next.length);
  let p = 0;
  while (p < max && cur.charCodeAt(p) === next.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && cur.charCodeAt(cur.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  return { from: base + p, to: base + cur.length - s, insert: next.slice(p, next.length - s) };
}
