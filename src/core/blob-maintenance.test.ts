import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { initSchema } from "./schema-init.ts";
import { putBlob } from "./cache.ts";
import { recordBlob, pendingBlobs } from "./blobs-core.ts";
import { blobMaintenance } from "./blobs.ts";
import {
  setStorageClientFactory,
  type StorageClient,
  type StorageObject,
  type StoragePutOpts,
  type S3Config,
} from "./sync/storage.ts";
import { MhError } from "./errors.ts";

// Counting in-memory bucket — proves the "no idle storm" property: how many times
// blobMaintenance actually writes to the bucket.
let putCount = 0;
const store = new Map<string, Uint8Array>();
const fake: StorageClient = {
  async list(prefix: string, startAfter?: string): Promise<StorageObject[]> {
    return [...store.keys()]
      .filter((k) => k.startsWith(prefix) && (startAfter == null || k > startAfter))
      .sort()
      .map((key) => ({ key }));
  },
  async get(key: string): Promise<Uint8Array | null> {
    return store.get(key) ?? null;
  },
  async put(key: string, body: Uint8Array, opts?: StoragePutOpts): Promise<void> {
    putCount++;
    if (opts?.ifNoneMatch && store.has(key)) throw new MhError("conflict", `exists: ${key}`);
    store.set(key, body);
  },
  async del(key: string): Promise<void> {
    store.delete(key);
  },
};

const ORIGINAL_HOME = process.env.METAHUB_HOME;
let TMP_HOME: string;
beforeAll(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), "mh-blob-maint-"));
  process.env.METAHUB_HOME = TMP_HOME;
  setStorageClientFactory(() => fake); // blobMaintenance resolves the client via this
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
  const cfg: S3Config = {
    endpoint: "https://x",
    region: "auto",
    bucket: "b",
    prefix: "mh",
    accessKeyId: "k",
    secretAccessKey: "s",
    encrypt: false, // plaintext → no master key needed for the fake
  };
  db.query("INSERT INTO peers (url, kind, enabled, config) VALUES ('s3://b/mh','s3',1,?)").run(
    JSON.stringify(cfg),
  );
  return db;
}

test("flushes pending productions to the bucket, then never re-touches already-flushed blobs", async () => {
  const db = makeNode("n1");
  // Produce two blobs (recordBlob defaults pending=1).
  const a = await putBlob("doc-image-a-bytes");
  recordBlob(db, a.hash, a.size, "image/png");
  const b = await putBlob("doc-image-b-bytes");
  recordBlob(db, b.hash, b.size, "image/png");
  expect(pendingBlobs(db).length).toBe(2);

  // First round: each pending blob is uploaded once and marked flushed.
  putCount = 0;
  const r1 = await blobMaintenance(db);
  expect(r1.flushed).toBe(2);
  expect(putCount).toBe(2);
  expect(pendingBlobs(db).length).toBe(0); // flushed → now clearable

  // The whole point of the refactor: a steady-state round touches the bucket ZERO
  // times (the old design re-HEAD/encrypted every held blob every minute).
  putCount = 0;
  const r2 = await blobMaintenance(db);
  expect(r2.flushed).toBe(0);
  expect(putCount).toBe(0);

  // A newly produced blob is the only thing the next round flushes.
  const c = await putBlob("doc-image-c-bytes");
  recordBlob(db, c.hash, c.size, "image/png");
  putCount = 0;
  const r3 = await blobMaintenance(db);
  expect(r3.flushed).toBe(1);
  expect(putCount).toBe(1);
});
