import type { DbDriver } from "./driver.ts";

// Hybrid Logical Clock. String form `<millis:15>-<counter:hex4>-<node>` so that
// lexicographic order == causal/total order (ASCII, fixed-width numeric parts).

export interface Hlc {
  millis: number;
  counter: number;
  node: string;
}

/** Max value of the fixed-width hex4 counter field. Beyond this the string
 *  form would grow to 5 hex digits (padStart pads, it never truncates) and
 *  break the lexicographic == causal ordering, so producers carry into millis
 *  instead (see nextHlc/observeHlc). */
export const MAX_HLC_COUNTER = 0xffff;

/** Carry a counter overflow into millis so the hex4 field stays fixed-width.
 *  Ordering is preserved: (millis+1, 0) sorts after (millis, 0xffff). */
function carryCounter(millis: number, counter: number): { millis: number; counter: number } {
  if (counter <= MAX_HLC_COUNTER) return { millis, counter };
  return {
    millis: millis + Math.floor(counter / (MAX_HLC_COUNTER + 1)),
    counter: counter % (MAX_HLC_COUNTER + 1),
  };
}

export function formatHlc(h: Hlc): string {
  // Defensive normalization: a counter beyond hex4 (e.g. parsed from a
  // malicious remote string) must never widen the field.
  const { millis, counter } = carryCounter(h.millis, h.counter);
  return `${String(millis).padStart(15, "0")}-${counter
    .toString(16)
    .padStart(4, "0")}-${h.node}`;
}

export function parseHlc(s: string): Hlc {
  const i1 = s.indexOf("-");
  const i2 = s.indexOf("-", i1 + 1);
  return {
    millis: Number(s.slice(0, i1)),
    counter: parseInt(s.slice(i1 + 1, i2), 16),
    node: s.slice(i2 + 1),
  };
}

function readLast(db: DbDriver, node: string): Hlc {
  const row = db.query("SELECT value FROM meta WHERE key = 'hlc'").get() as
    | { value: string }
    | null;
  return row ? parseHlc(row.value) : { millis: 0, counter: 0, node };
}

function writeLast(db: DbDriver, h: Hlc): void {
  db.query(
    "INSERT INTO meta (key, value) VALUES ('hlc', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(formatHlc(h));
}

/** Issue a new timestamp for a local event, advancing the persisted clock. */
export function nextHlc(db: DbDriver, node: string, now = Date.now()): string {
  const last = readLast(db, node);
  const millis = Math.max(last.millis, now);
  const counter = millis === last.millis ? last.counter + 1 : 0;
  // Counter overflow (e.g. >65k writes inside one frozen millisecond, a real
  // workerd workload) carries into millis instead of widening the hex4 field.
  const h: Hlc = { ...carryCounter(millis, counter), node };
  writeLast(db, h);
  return formatHlc(h);
}

/** Advance the local clock to account for an observed remote timestamp. */
export function observeHlc(
  db: DbDriver,
  node: string,
  remote: string,
  now = Date.now(),
): void {
  const last = readLast(db, node);
  const r = parseHlc(remote);
  // A malformed remote HLC (non-numeric prefix → NaN) must NEVER enter the local
  // clock: Math.max(last, NaN, now) is NaN, which formatHlc then persists as
  // "…NaN…", permanently wedging this node's clock (every later nextHlc reads
  // NaN back). Anonymous write-inbox ops make this reachable, so drop the poison
  // here as the last line of defense (the drop/grants layers reject it earlier).
  if (!Number.isFinite(r.millis) || !Number.isFinite(r.counter)) return;
  const millis = Math.max(last.millis, r.millis, now);
  let counter: number;
  if (millis === last.millis && millis === r.millis)
    counter = Math.max(last.counter, r.counter) + 1;
  else if (millis === last.millis) counter = last.counter + 1;
  else if (millis === r.millis) counter = r.counter + 1;
  else counter = 0;
  // Same overflow carry as nextHlc (a remote counter of 0xffff lands here).
  writeLast(db, { ...carryCounter(millis, counter), node });
}
