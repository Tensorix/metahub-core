import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { createDatabase } from "../databases.ts";
import {
  addAndSyncStoragePeer,
  addPeer,
  addStoragePeer,
  ensureFresh,
  getPeer,
  syncPeer,
  updatePeerStatus,
} from "./peers.ts";
import {
  setStorageClientFactory,
  type S3Config,
  type StorageClient,
  type StorageObject,
  type StoragePutOpts,
} from "./storage.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  runSchema(db);
  return db;
}

class TestBucket implements StorageClient {
  store = new Map<string, Uint8Array>();
  puts = 0;
  delayPut = false;
  failList = false;

  async list(prefix: string, startAfter?: string, delimiter?: string): Promise<StorageObject[]> {
    if (this.failList) throw new Error("bucket unavailable");
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix) && (startAfter == null || k > startAfter))
      .sort();
    if (!delimiter) return keys.map((key) => ({ key }));
    const out: StorageObject[] = [];
    const prefixes = new Set<string>();
    for (const k of keys) {
      const rest = k.slice(prefix.length);
      const i = rest.indexOf(delimiter);
      if (i >= 0) prefixes.add(prefix + rest.slice(0, i + 1));
      else out.push({ key: k });
    }
    for (const p of prefixes) out.push({ key: p });
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, body: Uint8Array, opts?: StoragePutOpts): Promise<void> {
    this.puts++;
    if (this.delayPut) await new Promise((resolve) => setTimeout(resolve, 20));
    if (opts?.ifNoneMatch && this.store.has(key)) throw new Error("exists");
    this.store.set(key, body);
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function s3Config(endpoint = "https://old.example"): S3Config {
  return {
    endpoint,
    region: "auto",
    bucket: "bucket",
    prefix: "metahub",
    accessKeyId: "id",
    secretAccessKey: "secret",
    encrypt: false,
  };
}

test("updatePeerStatus records attempts but only successful syncs update freshness", () => {
  const db = makeDb();
  addPeer(db, { url: "http://peer" });

  updatePeerStatus(db, "http://peer", "error", "offline");
  let row = db.query("SELECT last_sync_at, last_success_at, last_status FROM peers WHERE url = ?").get(
    "http://peer",
  ) as { last_sync_at: number | null; last_success_at: number | null; last_status: string };
  expect(typeof row.last_sync_at).toBe("number");
  expect(row.last_success_at).toBeNull();
  expect(row.last_status).toBe("error");

  updatePeerStatus(db, "http://peer", "ok", null);
  row = db.query("SELECT last_sync_at, last_success_at, last_status FROM peers WHERE url = ?").get(
    "http://peer",
  ) as { last_sync_at: number | null; last_success_at: number | null; last_status: string };
  expect(typeof row.last_sync_at).toBe("number");
  expect(typeof row.last_success_at).toBe("number");
  expect(row.last_status).toBe("ok");
});

test("ensureFresh ignores a recent failed attempt when there is no recent success", async () => {
  const db = makeDb();
  addPeer(db, { url: "http://127.0.0.1:9" });
  updatePeerStatus(db, "http://127.0.0.1:9", "error", "offline");

  await ensureFresh(db, { maxAgeMs: 60_000 });

  const row = db.query("SELECT last_status, last_success_at FROM peers WHERE url = ?").get(
    "http://127.0.0.1:9",
  ) as { last_status: string | null; last_success_at: number | null };
  expect(row.last_status).toBe("error");
  expect(row.last_success_at).toBeNull();
});

test("syncPeer coalesces concurrent rounds for the same peer", async () => {
  const db = makeDb();
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run("nodeAAAA");
  const bucket = new TestBucket();
  bucket.delayPut = true;
  setStorageClientFactory(() => bucket);
  const url = "s3://bucket/metahub";
  addStoragePeer(db, { url, config: s3Config(), label: "bucket" });
  createDatabase(db, { name: "Tasks" });

  const [a, b] = await Promise.all([syncPeer(db, url), syncPeer(db, url)]);

  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
  expect(bucket.puts).toBe(2); // HEAD + one segment, not doubled by the second caller
});

test("addAndSyncStoragePeer fails fast and removes a new peer when first sync fails", async () => {
  const db = makeDb();
  const bucket = new TestBucket();
  bucket.failList = true;
  setStorageClientFactory(() => bucket);

  await expect(
    addAndSyncStoragePeer(db, {
      endpoint: "https://bad.example",
      bucket: "bucket",
      accessKeyId: "id",
      secretAccessKey: "secret",
      encrypt: false,
    }),
  ).rejects.toThrow(/first sync failed/);

  expect(getPeer(db, "s3://bucket/metahub")).toBeNull();
});

test("addAndSyncStoragePeer restores an existing peer when first sync fails", async () => {
  const db = makeDb();
  const bucket = new TestBucket();
  bucket.failList = true;
  setStorageClientFactory(() => bucket);
  const url = "s3://bucket/metahub";
  addStoragePeer(db, { url, config: s3Config("https://old.example"), label: "old" });

  await expect(
    addAndSyncStoragePeer(db, {
      endpoint: "https://new.example",
      bucket: "bucket",
      accessKeyId: "id",
      secretAccessKey: "secret",
      encrypt: false,
      label: "new",
    }),
  ).rejects.toThrow(/first sync failed/);

  const row = getPeer(db, url)!;
  expect(row.label).toBe("old");
  expect((JSON.parse(row.config!) as S3Config).endpoint).toBe("https://old.example");
});
