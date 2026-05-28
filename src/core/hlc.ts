import type { Database } from "bun:sqlite";

// Hybrid Logical Clock. String form `<millis:15>-<counter:hex4>-<node>` so that
// lexicographic order == causal/total order (ASCII, fixed-width numeric parts).

export interface Hlc {
  millis: number;
  counter: number;
  node: string;
}

export function formatHlc(h: Hlc): string {
  return `${String(h.millis).padStart(15, "0")}-${h.counter
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

function readLast(db: Database, node: string): Hlc {
  const row = db.query("SELECT value FROM meta WHERE key = 'hlc'").get() as
    | { value: string }
    | null;
  return row ? parseHlc(row.value) : { millis: 0, counter: 0, node };
}

function writeLast(db: Database, h: Hlc): void {
  db.query(
    "INSERT INTO meta (key, value) VALUES ('hlc', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(formatHlc(h));
}

/** Issue a new timestamp for a local event, advancing the persisted clock. */
export function nextHlc(db: Database, node: string, now = Date.now()): string {
  const last = readLast(db, node);
  const millis = Math.max(last.millis, now);
  const counter = millis === last.millis ? last.counter + 1 : 0;
  const h: Hlc = { millis, counter, node };
  writeLast(db, h);
  return formatHlc(h);
}

/** Advance the local clock to account for an observed remote timestamp. */
export function observeHlc(
  db: Database,
  node: string,
  remote: string,
  now = Date.now(),
): void {
  const last = readLast(db, node);
  const r = parseHlc(remote);
  const millis = Math.max(last.millis, r.millis, now);
  let counter: number;
  if (millis === last.millis && millis === r.millis)
    counter = Math.max(last.counter, r.counter) + 1;
  else if (millis === last.millis) counter = last.counter + 1;
  else if (millis === r.millis) counter = r.counter + 1;
  else counter = 0;
  writeLast(db, { millis, counter, node });
}
