import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { initSchema } from "./schema-init.ts";
import { recordBlob, setPinned, isPinned, cachedBlobs, setFullNodes } from "./blobs-core.ts";
import { evictToQuota, clearCache } from "./blobs.ts";

// evictToQuota / clearCache touch the on-disk cache (cache.ts → METAHUB_HOME/cache).
// Point HOME at an empty temp dir: reconcileCache then finds no files (no-op) and
// deleteBlob is a 0-byte no-op, so these tests exercise the LEDGER logic (which
// rows are dropped, in what order) without writing real blob bytes.
const ORIGINAL_HOME = process.env.METAHUB_HOME;
let TMP_HOME: string;
beforeAll(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), "mh-blobs-evict-"));
  process.env.METAHUB_HOME = TMP_HOME;
});
afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.METAHUB_HOME;
  else process.env.METAHUB_HOME = ORIGINAL_HOME;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function makeNode(id: string): Database {
  const db = new Database(":memory:");
  initSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return db;
}

const hx = (c: string) => c.repeat(32);
const H1 = hx("a");
const H2 = hx("b");
const H3 = hx("c");

/** Force a deterministic last_access so LRU order is testable. */
function setAccess(db: Database, hash: string, at: number): void {
  db.query("UPDATE blob_cache SET last_access = ? WHERE hash = ?").run(at, hash);
}

/** A consumer node whose three blobs are all clearable (acquired caches, pending=0),
 *  each 100 bytes, with H1 oldest → H3 newest. A durable anchor is designated, so
 *  the safety floor is satisfied and clearability comes down to pending/LRU. */
function consumerWithThree(): Database {
  const phone = makeNode("phone");
  setFullNodes(phone, ["anchor"]); // designated anchor (the safety floor)
  recordBlob(phone, H1, 100, "image/png", 0);
  recordBlob(phone, H2, 100, "image/png", 0);
  recordBlob(phone, H3, 100, "image/png", 0);
  setAccess(phone, H1, 1000); // oldest
  setAccess(phone, H2, 2000);
  setAccess(phone, H3, 3000); // newest
  return phone;
}

const hashes = (db: Database) => new Set(cachedBlobs(db).map((b) => b.hash));

test("evictToQuota drops least-recently-used clearable blobs down to low-water", async () => {
  const db = consumerWithThree();
  // 300 total > 250 quota; low-water = floor(250*0.8)=200 → evict one (the oldest).
  const r = await evictToQuota(db, 250);
  expect(r.evicted).toBe(1);
  expect(hashes(db)).toEqual(new Set([H2, H3]));
});

test("evictToQuota is a no-op when under quota", async () => {
  const db = consumerWithThree();
  const r = await evictToQuota(db, 10_000);
  expect(r.evicted).toBe(0);
  expect(hashes(db).size).toBe(3);
});

test("evictToQuota disabled when quota <= 0", async () => {
  const db = consumerWithThree();
  const r = await evictToQuota(db, 0);
  expect(r.evicted).toBe(0);
  expect(hashes(db).size).toBe(3);
});

test("evictToQuota never drops a pinned blob (skips to next LRU)", async () => {
  const db = consumerWithThree();
  setPinned(db, H1, true); // pin the oldest
  const r = await evictToQuota(db, 250); // still must evict one
  expect(r.evicted).toBe(1);
  expect(hashes(db)).toEqual(new Set([H1, H3])); // H1 kept (pinned), H2 evicted
});

test("evictToQuota never drops a non-clearable (sole-copy) blob", async () => {
  const phone = makeNode("phone");
  setFullNodes(phone, ["anchor"]); // anchor designated, so pending is the ONLY protection
  // Produced-but-unflushed (pending) → never clearable, so never evicted.
  recordBlob(phone, H1, 100, "image/png");
  recordBlob(phone, H2, 100, "image/png");
  const r = await evictToQuota(phone, 50); // way over quota, but none clearable
  expect(r.evicted).toBe(0);
  expect(hashes(phone).size).toBe(2);
});

test("evictToQuota is a no-op when NO durable anchor is designated (safety floor)", async () => {
  const phone = makeNode("phone");
  // Three acquired caches (pending=0) but no anchor → none clearable → none evicted,
  // even far over quota. Guards against the background sweep deleting the last copy.
  recordBlob(phone, H1, 100, "image/png", 0);
  recordBlob(phone, H2, 100, "image/png", 0);
  recordBlob(phone, H3, 100, "image/png", 0);
  const r = await evictToQuota(phone, 50);
  expect(r.evicted).toBe(0);
  expect(hashes(phone).size).toBe(3);
});

test("clearCache keeps pinned blobs even when clearable", async () => {
  const db = consumerWithThree();
  setPinned(db, H2, true);
  const r = await clearCache(db);
  expect(r.cleared).toBe(2); // H1 + H3
  expect(r.skipped).toBe(1); // H2 pinned
  expect(hashes(db)).toEqual(new Set([H2]));
});

test("setPinned / isPinned round-trip; false for an unknown hash", () => {
  const db = consumerWithThree();
  expect(isPinned(db, H1)).toBe(false);
  expect(setPinned(db, H1, true)).toBe(true);
  expect(isPinned(db, H1)).toBe(true);
  expect(setPinned(db, H1, false)).toBe(true);
  expect(isPinned(db, H1)).toBe(false);
  expect(setPinned(db, hx("f"), true)).toBe(false); // not in ledger
});
