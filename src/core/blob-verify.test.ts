import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { initSchema } from "./schema-init.ts";
import { recordBlob, setFullNodes, setRedundancy, isAnchored, readBlobVerifiedAt } from "./blobs-core.ts";
import { verifyAnchorPresence } from "./blobs.ts";
import {
  setStorageClientFactory,
  type StorageClient,
  type StorageObject,
  type S3Config,
} from "./sync/storage.ts";

// Fake bucket: `bucketHas` is what the bucket holds; `bucketThrows` simulates the
// bucket being offline so the LIST fails (the anchor is then unverifiable).
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
const realFetch = globalThis.fetch;
beforeAll(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), "mh-blob-verify-"));
  process.env.METAHUB_HOME = TMP_HOME;
  setStorageClientFactory(() => fakeBucket);
});
afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.METAHUB_HOME;
  else process.env.METAHUB_HOME = ORIGINAL_HOME;
  globalThis.fetch = realFetch;
  rmSync(TMP_HOME, { recursive: true, force: true });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  bucketThrows = false;
});

/** Stub a device anchor's POST /api/blobs/has to report it holds `deviceHas`. */
function stubDeviceHas(deviceHas: Set<string>): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/blobs/has")) {
      const body = JSON.parse((init?.body as string) ?? "{}") as { hashes?: string[] };
      const has = (body.hashes ?? []).filter((h) => deviceHas.has(h));
      return new Response(JSON.stringify({ has }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

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
function addBucket(db: Database): void {
  db.query("INSERT INTO peers (url, kind, enabled, config) VALUES (?, 's3', 1, ?)").run(
    S3_URL,
    JSON.stringify(S3_CFG),
  );
}
function addDevice(db: Database, nodeId: string): void {
  db.query(
    "INSERT INTO peers (url, kind, enabled, token, node_id) VALUES ('http://dev', 'http', 1, 'tok', ?)",
  ).run(nodeId);
}

const hx = (c: string) => c.repeat(32);
const H1 = hx("a");
const H2 = hx("b");

test("verify marks only bucket-present blobs as anchored", async () => {
  const db = makeNode("phone");
  addBucket(db);
  setFullNodes(db, [S3_URL]);
  recordBlob(db, H1, 100, "image/png", 0);
  recordBlob(db, H2, 100, "image/png", 0);
  bucketHas = new Set([H1]); // bucket holds H1 only

  const r = await verifyAnchorPresence(db);
  expect(isAnchored(db, H1)).toBe(true);
  expect(isAnchored(db, H2)).toBe(false);
  expect(r.anchoredCount).toBe(1);
  expect(readBlobVerifiedAt(db)).not.toBeNull();
});

test("an unreachable bucket anchor is conservative: nothing anchored, listed unreachable", async () => {
  const db = makeNode("phone");
  addBucket(db);
  setFullNodes(db, [S3_URL]);
  recordBlob(db, H1, 100, "image/png", 0);
  bucketHas = new Set([H1]);
  bucketThrows = true; // bucket offline

  const r = await verifyAnchorPresence(db);
  expect(isAnchored(db, H1)).toBe(false);
  expect(r.unreachable).toContain(S3_URL);
});

test("redundancy any vs all across a bucket + a device anchor", async () => {
  const db = makeNode("phone");
  addBucket(db);
  addDevice(db, "devA");
  setFullNodes(db, [S3_URL, "devA"]);
  recordBlob(db, H1, 100, "image/png", 0);
  recordBlob(db, H2, 100, "image/png", 0);
  bucketHas = new Set([H1, H2]); // bucket has both
  stubDeviceHas(new Set([H1])); // device has only H1

  setRedundancy(db, "any");
  await verifyAnchorPresence(db);
  expect(isAnchored(db, H1)).toBe(true); // both
  expect(isAnchored(db, H2)).toBe(true); // bucket alone satisfies `any`

  setRedundancy(db, "all");
  await verifyAnchorPresence(db);
  expect(isAnchored(db, H1)).toBe(true); // present on both
  expect(isAnchored(db, H2)).toBe(false); // device lacks it → `all` fails
});

test("all with an unreachable anchor → nothing anchored", async () => {
  const db = makeNode("phone");
  addBucket(db);
  addDevice(db, "devA");
  setFullNodes(db, [S3_URL, "devA"]);
  setRedundancy(db, "all");
  recordBlob(db, H1, 100, "image/png", 0);
  bucketHas = new Set([H1]);
  bucketThrows = true; // bucket unreachable → can't confirm "all"

  const r = await verifyAnchorPresence(db);
  expect(isAnchored(db, H1)).toBe(false);
  expect(r.unreachable).toContain(S3_URL);
});

test("changing the anchor policy invalidates prior verdicts", async () => {
  const db = makeNode("phone");
  addBucket(db);
  setFullNodes(db, [S3_URL]);
  recordBlob(db, H1, 100, "image/png", 0);
  bucketHas = new Set([H1]);
  await verifyAnchorPresence(db);
  expect(isAnchored(db, H1)).toBe(true);
  expect(readBlobVerifiedAt(db)).not.toBeNull();

  setFullNodes(db, [S3_URL, "other"]); // anchor set changed
  expect(isAnchored(db, H1)).toBe(false); // verdict cleared
  expect(readBlobVerifiedAt(db)).toBeNull(); // must re-verify
});

test("no designated anchor → verify clears everything and stamps a time", async () => {
  const db = makeNode("phone");
  recordBlob(db, H1, 100, "image/png", 0);
  const r = await verifyAnchorPresence(db);
  expect(r.anchoredCount).toBe(0);
  expect(isAnchored(db, H1)).toBe(false);
  expect(readBlobVerifiedAt(db)).not.toBeNull();
});
