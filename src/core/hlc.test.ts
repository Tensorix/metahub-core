import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import {
  formatHlc,
  parseHlc,
  nextHlc,
  observeHlc,
  MAX_HLC_COUNTER,
  HLC_MAX_SKEW_MS,
  isSkewedHlc,
  type Hlc,
} from "./hlc.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  runSchema(db);
  return db;
}

function setClock(db: Database, h: Hlc): void {
  db.query(
    "INSERT INTO meta (key, value) VALUES ('hlc', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(`${String(h.millis).padStart(15, "0")}-${h.counter.toString(16).padStart(4, "0")}-${h.node}`);
}

test("formatHlc keeps the counter field fixed-width (carry, never widen)", () => {
  const ok = formatHlc({ millis: 1000, counter: MAX_HLC_COUNTER, node: "n" });
  expect(ok).toBe("000000000001000-ffff-n");

  // One past the max: carries into millis instead of widening to 5 hex digits.
  const carried = formatHlc({ millis: 1000, counter: MAX_HLC_COUNTER + 1, node: "n" });
  expect(carried).toBe("000000000001001-0000-n");

  // Lexicographic order preserved across the carry boundary.
  expect(carried > ok).toBe(true);
  // Old (buggy) form would have been "...-10000-n", which sorts BELOW "...-ffff-n".
  expect("000000000001000-10000-n" < ok).toBe(true);
});

test("nextHlc carries a counter overflow into millis under a frozen clock", () => {
  const db = makeDb();
  const frozen = 5_000;
  setClock(db, { millis: frozen, counter: MAX_HLC_COUNTER, node: "n" });

  const prev = formatHlc({ millis: frozen, counter: MAX_HLC_COUNTER, node: "n" });
  // Frozen clock (now == last.millis) forces the counter path, which overflows.
  const next = nextHlc(db, "n", frozen);
  const parsed = parseHlc(next);
  expect(parsed.millis).toBe(frozen + 1);
  expect(parsed.counter).toBe(0);
  expect(next.length).toBe(prev.length); // fixed width held
  expect(next > prev).toBe(true); // order held

  // And the persisted clock keeps issuing monotonically after the carry.
  const after = nextHlc(db, "n", frozen);
  expect(after > next).toBe(true);
});

test("observeHlc carries a remote counter at the ceiling", () => {
  const db = makeDb();
  const frozen = 9_000;
  const remote = formatHlc({ millis: frozen, counter: MAX_HLC_COUNTER, node: "r" });
  observeHlc(db, "n", remote, frozen);
  // max(local 0, remote 0xffff)+1 overflows -> millis+1, counter 0.
  const issued = nextHlc(db, "n", frozen);
  expect(issued > remote).toBe(true);
  const parsed = parseHlc(issued);
  expect(parsed.counter).toBeLessThanOrEqual(MAX_HLC_COUNTER);
  expect(parsed.millis).toBeGreaterThanOrEqual(frozen + 1);
});

test("sustained same-millisecond issuance never breaks ordering", () => {
  const db = makeDb();
  const frozen = 1_234;
  setClock(db, { millis: frozen, counter: MAX_HLC_COUNTER - 2, node: "n" });
  let prev = "";
  for (let i = 0; i < 8; i++) {
    const h = nextHlc(db, "n", frozen); // crosses the carry boundary mid-loop
    if (prev) expect(h > prev).toBe(true);
    expect(h.length).toBe(prev.length || h.length);
    prev = h;
  }
});

test("nextHlc refuses to mint while the persisted clock is more than HLC_MAX_SKEW_MS ahead", () => {
  const db = makeDb();
  const now = 1_000_000_000;
  nextHlc(db, "n", now + HLC_MAX_SKEW_MS + 1);
  expect(() => nextHlc(db, "n", now)).toThrow(/mh repair --clock/);
  nextHlc(db, "n", now + HLC_MAX_SKEW_MS + 2);
});

test("observeHlc ignores a remote timestamp more than HLC_MAX_SKEW_MS in the future", () => {
  const db = makeDb();
  const now = 1_000_000_000;
  observeHlc(db, "n", formatHlc({ millis: now + HLC_MAX_SKEW_MS + 60_000, counter: 0, node: "r" }), now);
  expect(parseHlc(nextHlc(db, "n", now)).millis).toBe(now);
  observeHlc(db, "n", formatHlc({ millis: now + 1000, counter: 0, node: "r" }), now);
  expect(parseHlc(nextHlc(db, "n", now)).millis).toBe(now + 1000);
});

test("isSkewedHlc / hlcSkewBound bracket the window regardless of counter and node", () => {
  const now = 1_000_000_000;
  expect(isSkewedHlc(formatHlc({ millis: now + HLC_MAX_SKEW_MS, counter: MAX_HLC_COUNTER, node: "zzzzzzzz" }), now)).toBe(false);
  expect(isSkewedHlc(formatHlc({ millis: now + HLC_MAX_SKEW_MS + 1, counter: 0, node: "00000000" }), now)).toBe(true);
});
