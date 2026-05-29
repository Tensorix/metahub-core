// Fractional indexing: compact string keys that sort lexicographically, so a new
// key can always be produced strictly between two existing ones. Used to order
// document blocks; concurrent inserts at the same slot are tie-broken by block id.
//
// Alphabet is base62 with ASCII order matching digit order (0-9 < A-Z < a-z), so
// SQLite's default BINARY collation orders keys correctly with plain `ORDER BY`.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * A digit string strictly between `a` and `b`. `a` is a digit string (possibly
 * "" = start) and `b` is a digit string or null (= end), with `a < b`. Neither
 * may end in the zero digit; this invariant is preserved by construction.
 */
function midpoint(a: string, b: string | null): string {
  const zero = DIGITS[0]!;
  if (b !== null && a >= b) throw new Error(`fracdex: ${a} >= ${b}`);
  if (a.endsWith(zero) || (b !== null && b.endsWith(zero)))
    throw new Error(`fracdex: trailing zero in ${a}/${b}`);

  if (b !== null) {
    // Strip the common prefix, padding `a` with implicit zeros as we descend.
    let n = 0;
    while ((a[n] ?? zero) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }

  const da = a === "" ? 0 : DIGITS.indexOf(a[0]!);
  const db = b === null ? DIGITS.length : DIGITS.indexOf(b[0]!);
  if (db - da > 1) {
    const mid = Math.round(0.5 * (da + db));
    return DIGITS[mid]!;
  }
  // First digits are consecutive (or equal at the boundary): descend.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da]! + midpoint(a.slice(1), null);
}

/** A key strictly between `a` and `b` (lexicographically). null = open boundary. */
export function keyBetween(a: string | null, b: string | null): string {
  return midpoint(a ?? "", b);
}

/** `n` distinct keys in ascending order, all strictly between `a` and `b`. */
export function keysBetween(
  a: string | null,
  b: string | null,
  n: number,
): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];

  if (b === null) {
    let prev = keyBetween(a, null);
    const out = [prev];
    for (let i = 1; i < n; i++) {
      prev = keyBetween(prev, null);
      out.push(prev);
    }
    return out;
  }
  if (a === null) {
    let next = keyBetween(null, b);
    const out = [next];
    for (let i = 1; i < n; i++) {
      next = keyBetween(null, next);
      out.unshift(next);
    }
    return out;
  }

  // Both bounded: bisect so key lengths grow logarithmically.
  const mid = Math.floor(n / 2);
  const c = keyBetween(a, b);
  return [...keysBetween(a, c, mid), c, ...keysBetween(c, b, n - mid - 1)];
}
