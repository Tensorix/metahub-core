import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { initSchema } from "./schema-init.ts";
import {
  recordBlob,
  setPinned,
  isPinned,
  isAnchored,
  setAnchored,
  cachedBlobs,
  setFullNodes,
} from "./blobs-core.ts";
import { evictToQuota, clearCache } from "./blobs.ts";
import {
  setStorageClientFactory,
  type StorageClient,
  type StorageObject,
  type S3Config,
} from "./sync/storage.ts";

// evictToQuota / clearCache touch the on-disk cache (cache.ts → METAHUB_HOME/cache).
// Point HOME at an empty temp dir: reconcileCache then finds no files (no-op) and
// deleteBlob is a 0-byte no-op, so these tests exercise the LEDGER logic (which
// rows are dropped, in what order) without writing real blob bytes.
//
// evictToQuota now runs verifyAnchorPresence when over quota, so we register a fake
// bucket anchor: `bucketHas` is the hash set the bucket "holds"; `bucketThrows`
// simulates the bucket being offline (verify then can't confirm → keeps bytes).
let bucketHas = new Set<string>();
let bucketThrows = false;
const fakeBucket: StorageClient = {
  async list(prefix: string): Promise<StorageObject[]> {
    if (bucketThrows) throw new Error("bucket offline");
    return [...bucketHas].map((h) => ({ key: prefix + h }));
  },
  async get() {
    return null;
  },
  async put() {},
  async del() {},
};

const ORIGINAL_HOME = process.env.METAHUB_HOME;
let TMP_HOME: string;
beforeAll(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), "mh-blobs-evict-"));
  process.env.METAHUB_HOME = TMP_HOME;
  setStorageClientFactory(() => fakeBucket);
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

const S3_URL = "s3://b/mh";
const S3_CFG: S3Config = {
  endpoint: "https://x",
  region: "auto",
  bucket: "b",
  prefix: "mh",
  accessKeyId: "k",
  secretAccessKey: "s",
  encrypt: false,
};

/** Attach an object-storage bucket and designate it as the full-blob anchor. */
function designateBucket(db: Database): void {
  db.query("INSERT INTO peers (url, kind, enabled, config) VALUES (?, 's3', 1, ?)").run(
    S3_URL,
    JSON.stringify(S3_CFG),
  );
  setFullNodes(db, [S3_URL]);
}

const hx = (c: string) => c.repeat(32);
const H1 = hx("a");
const H2 = hx("b");
const H3 = hx("c");

/** Force a deterministic last_access so LRU order is testable. */
function setAccess(db: Database, hash: string, at: number): void {
  db.query("UPDATE blob_cache SET last_access = ? WHERE hash = ?").run(at, hash);
}

/** A consumer node with three acquired (pending=0), already-verified-anchored blobs
 *  of 100 bytes each, oldest→newest H1→H3, behind a reachable bucket anchor holding
 *  all three. clearCache reads the pre-set `anchored`; evictToQuota re-verifies it. */
function consumerWithThree(): Database {
  const phone = makeNode("phone");
  designateBucket(phone);
  recordBlob(phone, H1, 100, "image/png", 0);
  recordBlob(phone, H2, 100, "image/png", 0);
  recordBlob(phone, H3, 100, "image/png", 0);
  bucketHas = new Set([H1, H2, H3]);
  bucketThrows = false;
  setAnchored(phone, H1, true);
  setAnchored(phone, H2, true);
  setAnchored(phone, H3, true);
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
  designateBucket(phone); // anchor designated, so pending is the ONLY protection
  // Produced-but-unflushed (pending) → never clearable, so never evicted, even if
  // the bucket happens to also hold them.
  recordBlob(phone, H1, 100, "image/png");
  recordBlob(phone, H2, 100, "image/png");
  bucketHas = new Set([H1, H2]);
  bucketThrows = false;
  const r = await evictToQuota(phone, 50); // way over quota, but none clearable
  expect(r.evicted).toBe(0);
  expect(hashes(phone).size).toBe(2);
});

test("evictToQuota is a no-op when NO durable anchor is designated (safety floor)", async () => {
  const phone = makeNode("phone");
  // Three acquired caches (pending=0) but no anchor → verify marks none anchored →
  // none clearable → none evicted, even far over quota.
  recordBlob(phone, H1, 100, "image/png", 0);
  recordBlob(phone, H2, 100, "image/png", 0);
  recordBlob(phone, H3, 100, "image/png", 0);
  const r = await evictToQuota(phone, 50);
  expect(r.evicted).toBe(0);
  expect(hashes(phone).size).toBe(3);
});

test("evictToQuota over quota but anchor offline → evicts nothing, resets anchored (offline degradation)", async () => {
  const db = consumerWithThree();
  bucketThrows = true; // bucket unreachable at verify time
  const r = await evictToQuota(db, 250); // over quota, but can't confirm presence
  expect(r.evicted).toBe(0); // defer: allow over-quota rather than risk loss
  expect(hashes(db).size).toBe(3);
  expect(isAnchored(db, H1)).toBe(false); // stale verdict cleared, not reused
});

test("clearCache keeps pinned blobs even when clearable", async () => {
  const db = consumerWithThree();
  setPinned(db, H2, true);
  const r = await clearCache(db); // clearCache reads the pre-set anchored verdict
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
