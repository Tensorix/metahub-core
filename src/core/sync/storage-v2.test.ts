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

async function futureLog(f: Awaited<ReturnType<typeof pair>>) {
    const { createCommitLog } = await import("./commit-log.ts");
    const { parseRetentionEvent } = await import("./retention-protocol.ts");
    const { initialRetentionState, reduceRetention } = await import("./retention-state.ts");
    // Simulated newer binary, with the same wire envelope and sealed barrier.
    return createCommitLog({ client: f.client, prefix: f.bucket.prefix, workspaceId: f.root.workspaceId,
      codec: f.bucket.codec, initialState: () => ({ ...initialRetentionState(), checkpoint: f.root.checkpoint } as ReturnType<typeof initialRetentionState>),
      parsePayload: parseRetentionEvent, reduce: reduceRetention });
}

test("an accepted future upgrade stops an offline writer before the next slot and survives reopen", async () => {
  const f = await pair();
  try {
    const draft = createDocument(f.a, { title: "offline draft", body: "saved locally" });
    const future = await futureLog(f);
    await future.append("prepare3", () => ({ type: "prepare", id: "v3", epoch: 0, targetDataVersion: 3 }));
    const cp = captureCurrentCheckpoint(f.b, f.root.workspaceId, 1);
    cp.coveredSequence = 1;
    const hash = await f.bucket.publish(cp);
    await future.append("upgrade3", () => ({ type: "upgrade", id: "v3", epoch: 0, workspaceId: f.root.workspaceId, from: 2, to: 3, checkpoint: hash }));
    const keys = [...f.objects.keys()];
    await expect(syncWithStorageV2(f.a, f.client, f.config)).rejects.toMatchObject({ code: "client_update_required", i18n: { params: { workspaceDataVersion: 3, clientMaxDataVersion: 2 } } });
    expect([...f.objects.keys()]).toEqual(keys);
    const reopened = Database.deserialize(f.a.serialize());
    try {
      expect(getDocument(reopened, draft.id)?.body).toBe("saved locally");
      expect(() => createDocument(reopened, { title: "blocked" })).toThrow("需要更新客户端");
      expect(() => reopened.query("DELETE FROM documents").run()).toThrow("client_update_required");
      const { observeDataVersion } = await import("./data-version.ts");
      expect(() => observeDataVersion(reopened, f.root.workspaceId, 2)).toThrow("需要更新客户端");
    } finally { reopened.close(); }
  } finally { f.a.close(); f.b.close(); }
});

// Two binary versions are simulated sequentially against the same test bucket.
test.serial("only an explicit migration advances the version; interrupted publication is retryable", async () => {
  const { dataVersionRange, assertWorkspaceWritable } = await import("./data-version.ts");
  const { upgradeWorkspaceData } = await import("./retention-executor.ts");
  const { recoverV2Workspace } = await import("./recovery-v2.ts");
  const f = await pair();
  const max = dataVersionRange.maxSupportedDataVersion;
  let rebuilt: Database | undefined;
  try {
    const offline = createDocument(f.b, { title: "offline", body: "saved before migration" });
    await syncWithStorageV2(f.a, f.client, f.config);
    expect(() => upgradeWorkspaceData(f.a, f.client, f.config, 3)).toThrow("需要更新客户端");
    Object.defineProperty(dataVersionRange, "maxSupportedDataVersion", { value: 3 });
    await syncWithStorageV2(f.a, f.client, f.config);
    expect((await f.bucket.log(f.root).read()).state.dataVersion).toBe(2);
    expect((await upgradeWorkspaceData(f.a, f.client, f.config, 3)).status).toBe("waiting_for_seals");
    await syncWithStorageV2(f.a, f.client, f.config);
    const failing = { ...f.client, put: async (...args: Parameters<StorageClient["put"]>) => {
      if (args[0].includes("/objects/")) throw new Error("upload interrupted");
      return f.client.put(...args);
    } };
    await expect(upgradeWorkspaceData(f.a, failing, f.config, 3)).rejects.toThrow("upload interrupted");
    expect((await f.bucket.log(f.root).read()).state.dataVersion).toBe(2);
    const attempts = await Promise.allSettled([
      upgradeWorkspaceData(f.a, f.client, f.config, 3),
      upgradeWorkspaceData(f.a, f.client, f.config, 3),
    ]);
    expect(attempts.some(a => a.status === "fulfilled" && a.value.status === "committed")).toBe(true);
    expect((await f.bucket.log(f.root).read()).state.epoch).toBe(1);
    Object.defineProperty(dataVersionRange, "maxSupportedDataVersion", { value: max });
    await expect(syncWithStorageV2(f.b, f.client, f.config)).rejects.toMatchObject({ code: "client_update_required" });
    const { saveVersionDraft } = await import("./data-version.ts");
    saveVersionDraft(f.b, { editor: crypto.randomUUID(), doc_id: offline.id, title: "editor draft", body: "typed during detection", version: null });
    Object.defineProperty(dataVersionRange, "maxSupportedDataVersion", { value: 3 });
    expect(() => assertWorkspaceWritable(f.b)).toThrow("联网");
    await expect(syncWithStorageV2(f.b, f.client, f.config)).rejects.toMatchObject({ code: "rebootstrap_required" });
    let saved = false;
    const result = await recoverV2Workspace(f.b, f.client, f.config, f.root.workspaceId, {
      pauseAndFlush: async () => {}, protect: async () => { saved = true; return { proof: "test" }; },
      createShadow: async () => f.db(), swap: async db => { rebuilt = db as Database; },
      releaseShadow: async () => {}, resume: async () => {},
    });
    expect(saved).toBe(true);
    expect(result.pending).toBeGreaterThan(0);
    expect(getDocument(f.b, offline.id)?.body).toBe("saved before migration");
    expect(getDocument(rebuilt!, f.doc.id)?.body).toBe(f.doc.body);
    const { recoveryItems } = await import("./recovery-v2.ts");
    expect(recoveryItems(rebuilt!).some(item => item.kind === "sync_version_drafts" && JSON.parse(item.local).body === "typed during detection")).toBe(true);
    expect(() => createDocument(rebuilt!, { title: "online again" })).not.toThrow();
  } finally {
    Object.defineProperty(dataVersionRange, "maxSupportedDataVersion", { value: max });
    rebuilt?.close(); f.a.close(); f.b.close();
  }
});

test("a missing root above an existing log cannot trigger initialization or legacy upload", async () => {
  const f = await pair();
  const first = f.db();
  try {
    await syncWithStorageV2(f.a, f.client, f.config);
    f.objects.delete(f.bucket.prefix + "/root");
    const keys = [...f.objects.keys()];
    const { syncWithStorage } = await import("./storage.ts");
    for (const db of [f.a, first])
      await expect(syncWithStorage(db, "s3://bucket", f.client, f.config)).rejects.toMatchObject({ code: "busy" });
    expect([...f.objects.keys()]).toEqual(keys);
  } finally { first.close(); f.a.close(); f.b.close(); }
});


test("an old writer losing its conditional slot to an upgrade cannot append a later slot", async () => {
  const f = await pair();
  try {
    const future = await futureLog(f);
    let race = true;
    const competing = { ...f.client, put: async (...args: Parameters<StorageClient["put"]>) => {
      if (race && args[0].endsWith("0000000000000001.commit")) {
        race = false;
        await future.append("prepare", () => ({ type: "prepare", id: "upgrade", epoch: 0, targetDataVersion: 3 }));
        const cp = captureCurrentCheckpoint(f.b, f.root.workspaceId, 1);
        cp.coveredSequence = 1;
        const checkpoint = await f.bucket.publish(cp);
        await future.append("finish", () => ({ type: "upgrade", workspaceId: f.root.workspaceId, id: "upgrade", epoch: 0, from: 2, to: 3, checkpoint }));
      }
      return f.client.put(...args);
    } };
    const old = createV2Bucket(competing, f.config, f.a);
    await expect(old.log(f.root).append("old-clock", () => ({ type: "clock" }))).rejects.toMatchObject({ code: "client_update_required" });
    expect((await future.read()).sequence).toBe(2);
  } finally { f.a.close(); f.b.close(); }
});
