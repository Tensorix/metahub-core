import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { createDocument, getDocument } from "../documents.ts";
import { captureCurrentCheckpoint, installCurrentCheckpoint } from "./current-checkpoint.ts";
import { createV2Bucket } from "./bucket-v2.ts";
import { syncWithStorageV2 } from "./storage-v2.ts";
import { dataMap } from "./data-map-db.ts";
import { addStoragePeer, updatePeerStatus } from "./peers.ts";
import { readReplicaGeneration, writeReplicaGeneration } from "./retention-protocol.ts";
import { MhError } from "../errors.ts";
import type { StorageClient, StorageReadResult, S3Config } from "./storage.ts";

function fixture() {
  const objects = new Map<string, StorageReadResult>();
  let now = Date.now();
  const client: StorageClient = {
    conditionalCreateCapability: async () => true,
    list: async () => { throw new Error("LIST forbidden"); },
    get: async key => objects.get(key)?.bytes ?? null,
    getWithMetadata: async key => { const value = objects.get(key); return value ? { ...value, serverDate: now } : null; },
    put: async (key, bytes, opts) => {
      if (opts?.ifNoneMatch && objects.has(key)) throw new MhError("conflict", "occupied");
      objects.set(key, { bytes: bytes.slice(), lastModified: ++now, serverDate: now, etag: null });
    },
    del: async key => { objects.delete(key); },
  };
  const config: S3Config = { endpoint: "https://test.invalid", bucket: "test", region: "test", prefix: "test", encrypt: false, accessKeyId: "test", secretAccessKey: "test" };
  const db = () => { const db = new Database(":memory:"); runSchema(db); return db; };
  return { client, config, objects, db, advance: (days: number) => { now += days * 86400000; } };
}
async function pair() {
  const f = fixture(), a = f.db(), b = f.db(), bucket = createV2Bucket(f.client, f.config);
  const doc = createDocument(a, { title: "initial", body: "initial body" });
  const root = await bucket.initialize(captureCurrentCheckpoint(a, "workspace", 0));
  installCurrentCheckpoint(b, await bucket.checkpointFor(root, root.checkpoint, 0), "workspace");
  for (const [db, incarnationId] of [[a, "a"], [b, "b"]] as const)
    writeReplicaGeneration(db, { protocolVersion: 2, workspaceId: "workspace", epoch: 0, checkpoint: root.checkpoint, incarnationId });
  return { ...f, a, b, bucket, root, doc };
}
test("v2 real SQLite replicas exchange batches without LIST and do not republish received operations", async () => {
  const f = await pair();
  try {
    await syncWithStorageV2(f.a, f.client, f.config);
    await syncWithStorageV2(f.b, f.client, f.config);
    const doc = createDocument(f.a, { title: "new", body: "new text" });
    expect((await syncWithStorageV2(f.a, f.client, f.config)).pushed).toBeGreaterThan(0);
    await syncWithStorageV2(f.b, f.client, f.config);
    expect(getDocument(f.b, doc.id)?.body).toBe("new text");
    expect((await syncWithStorageV2(f.b, f.client, f.config)).pushed).toBe(0);
  } finally { f.a.close(); f.b.close(); }
});
test("lost commit response retries durable outbox with no source gap or duplicate batch", async () => {
  const f = await pair(), put = f.client.put;
  let lost = false;
  f.client.put = async (key, bytes, opts) => {
    await put(key, bytes, opts);
    if (!lost && key.endsWith("0000000000000002.commit")) { lost = true; throw new Error("lost response"); }
  };
  try {
    await expect(syncWithStorageV2(f.a, f.client, f.config)).rejects.toThrow("lost response");
    await syncWithStorageV2(f.a, f.client, f.config);
    const head = await f.bucket.log(f.root).read();
    expect(head.sequence).toBe(2);
    expect(head.state.members.a!.sequence).toBeGreaterThan(0);
  } finally { f.a.close(); f.b.close(); }
});
test("missing committed object stops pull before a later batch can acknowledge coverage", async () => {
  const f = await pair();
  try {
    await syncWithStorageV2(f.a, f.client, f.config);
    let digest = "";
    await f.bucket.log(f.root).read(undefined, async r => { if (r.payload.type === "batch") digest = r.payload.objectHash; });
    const key = f.bucket.objectKey(digest), stored = f.objects.get(key)!;
    f.objects.delete(key);
    await expect(syncWithStorageV2(f.b, f.client, f.config)).rejects.toMatchObject({ code: "busy" });
    expect((await f.bucket.log(f.root).read()).state.members.b).toBeUndefined();
    f.objects.set(key, stored);
    await syncWithStorageV2(f.b, f.client, f.config);
  } finally { f.a.close(); f.b.close(); }
});
test("simultaneous migration proposals select a single root", async () => {
  const f = fixture(), a = f.db(), b = f.db(), bucket = createV2Bucket(f.client, f.config);
  try {
    createDocument(a, { title: "a" }); createDocument(b, { title: "b" });
    const [left, right] = await Promise.all([bucket.initialize(captureCurrentCheckpoint(a, "w", 0)), bucket.initialize(captureCurrentCheckpoint(b, "w", 0))]);
    expect(left).toEqual(right);
  } finally { a.close(); b.close(); }
});


test("lease expiration without an epoch change rotates identity and retains pending edits", async () => {
  const f = await pair();
  try {
    await syncWithStorageV2(f.a, f.client, f.config);
    const doc = createDocument(f.a, { title: "offline", body: "queued content" });
    f.advance(31);
    await syncWithStorageV2(f.a, f.client, f.config);
    expect(readReplicaGeneration(f.a)!.incarnationId).not.toBe("a");
    expect(readReplicaGeneration(f.a)!.epoch).toBe(0);
    await syncWithStorageV2(f.b, f.client, f.config);
    expect(getDocument(f.b, doc.id)?.body).toBe("queued content");
  } finally { f.a.close(); f.b.close(); }
});

test("late transport completion after abort never acknowledges the durable outbox", async () => {
  const f = await pair(), controller = new AbortController(), put = f.client.put;
  f.client.put = async (key, bytes, opts) => {
    await put(key, bytes, opts);
    if (key.endsWith("0000000000000002.commit")) controller.abort(new Error("background suspension"));
  };
  try {
    await expect(syncWithStorageV2(f.a, f.client, f.config, { signal: controller.signal })).rejects.toThrow("background suspension");
    const before = f.a.query("SELECT value FROM meta WHERE key='sync_v2_transport:a:outbox'").get() as { value: string };
    expect(JSON.parse(before.value)).not.toBeNull();
    f.client.put = put;
    await syncWithStorageV2(f.a, f.client, f.config);
    expect((await f.bucket.log(f.root).read()).state.members.a!.sequence).toBeGreaterThan(0);
    expect((await f.bucket.log(f.root).read()).sequence).toBe(2);
  } finally { f.a.close(); f.b.close(); }
});

test("bucket status follows v2 acknowledgements through partial and completed uploads", async () => {
  const f = await pair();
  const url = "s3://test/workspace", other = "s3://test/other";
  try {
    for (const target of [url, other]) {
      addStoragePeer(f.a, { url: target, config: f.config });
      updatePeerStatus(f.a, target, "ok");
    }
    f.a.query("INSERT INTO meta(key,value) VALUES('local_v2_history_peer',?)").run(url);
    const status = (target: string) => dataMap(f.a).places.find(p => p.url === target)!;
    await syncWithStorageV2(f.a, f.client, f.config, { pushLimit: 1 });
    expect(status(url).freshness).toBe("behind");
    await syncWithStorageV2(f.a, f.client, f.config);
    expect(status(url).freshness).toBe("current");
    expect(status(other).freshness).toBe("behind");
    createDocument(f.a, { title: "new local edit" });
    expect(status(url).freshness).toBe("behind");
    await syncWithStorageV2(f.a, f.client, f.config);
    expect(status(url).lag).toBe(0);
  } finally { f.a.close(); f.b.close(); }
});
