import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../schema-init.ts";
import { createDocument, getDocument, updateDocument } from "../documents.ts";
import { describeSelf, getNodeId } from "../node.ts";
import { MhError } from "../errors.ts";
import { createV2Bucket } from "./bucket-v2.ts";
import { captureCurrentCheckpoint } from "./current-checkpoint.ts";
import { addPeer, addStoragePeer, getPeer } from "./peers.ts";
import { readReplicaGeneration, writeReplicaGeneration, needsBucketUpgrade } from "./retention-protocol.ts";
import { canAutoJoinWorkspace, workspaceAccess } from "./workspace-access.ts";
import { inspectBucketAccess } from "./workspace-bucket.ts";
import { recoverConnectedWorkspace, type WorkspaceTarget } from "./workspace-recovery.ts";
import { installLocalConnections } from "./recovery-local.ts";
import { captureHttpBootstrap } from "./http-bootstrap.ts";
import { routes } from "./routes.ts";
import { recoveryItems } from "./recovery-v2.ts";
import { syncWithStorage } from "./storage.ts";
import { syncWithPeer } from "./client.ts";
import type { S3Config, StorageClient, StorageReadResult } from "./storage.ts";

const config: S3Config = { endpoint: "https://fixture.invalid", bucket: "test", prefix: "fixture", region: "test", encrypt: false, accessKeyId: "test", secretAccessKey: "test" };
const url = "s3://fixture/test";
function db() { const value = new Database(":memory:"); initSchema(value); return value; }
function storage() {
  const objects = new Map<string, StorageReadResult>(); let now = Date.now();
  const client: StorageClient = {
    conditionalCreateCapability: async () => true,
    list: async prefix => [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })),
    get: async key => objects.get(key)?.bytes ?? null,
    getWithMetadata: async key => { const object = objects.get(key); return object ? { ...object, serverDate: now } : null; },
    put: async (key, bytes, options) => {
      if (options?.ifNoneMatch && objects.has(key)) throw new MhError("conflict", "occupied");
      objects.set(key, { bytes: bytes.slice(), lastModified: ++now, serverDate: now, etag: null });
    },
    del: async key => { objects.delete(key); },
  };
  return { objects, client };
}
async function recover(source: Database, target: WorkspaceTarget, automatic = true) {
  let active: Database | undefined;
  const result = await recoverConnectedWorkspace(source, target, {
    pauseAndFlush: async () => {}, protect: async () => ({ proof: "synthetic-memory-protection" }),
    createShadow: async () => { const shadow = db(); installLocalConnections(source, shadow, target.url); return shadow; },
    swap: async shadow => { active = shadow as Database; }, releaseShadow: async (shadow, committed) => { if (!committed) (shadow as Database).close(); }, resume: async () => {},
  }, automatic);
  return { active: active!, result };
}
async function remote() {
  const f = storage(), server = db();
  const doc = createDocument(server, { title: "remote", body: "current state" });
  const bucket = createV2Bucket(f.client, config);
  const root = await bucket.initialize(captureCurrentCheckpoint(server, "workspace", 0));
  writeReplicaGeneration(server, { protocolVersion: 2, workspaceId: root.workspaceId, epoch: 0, checkpoint: root.checkpoint, incarnationId: "server" });
  return { ...f, server, doc, bucket, root };
}
function http(server: Database, afterSnapshot?: () => void, corrupt = false): typeof fetch {
  return (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const route = routes.find(r => r.path === path && r.method === (init?.method ?? "GET"));
    if (!route) return new Response("missing", { status: 404 });
    const response = await route.handler(new Request(String(input), init as RequestInit), { db: server, node: getNodeId(server) });
    if (path === "/sync/bootstrap") {
      afterSnapshot?.();
      if (corrupt) { const value = await response.json(); value.snapshot.current.changes[0].value = '"tampered"'; return Response.json(value); }
    }
    return response;
  }) as typeof fetch;
}

test("automatic enrollment rejects business tombstones, drafts, attachment queues and prior bindings", () => {
  const fresh = db();
  try { describeSelf(fresh, { app: "web", platform: "web", form: "browser", defaultLabel: "self" }); expect(canAutoJoinWorkspace(fresh)).toBe(true); } finally { fresh.close(); }
  for (const table of ["replica_document_drafts", "mobile_attachment_transfers", "sync_recovery_items"]) {
    const source = db(); try { source.exec(`CREATE TABLE ${table}(id TEXT); INSERT INTO ${table} VALUES('pending')`); expect(canAutoJoinWorkspace(source)).toBe(false); } finally { source.close(); }
  }
  const source = db(); try {
    source.query("INSERT INTO documents(id,title,__deleted) VALUES('deleted','old',1)").run();
    expect(canAutoJoinWorkspace(source)).toBe(false);
  } finally { source.close(); }
});

test("fresh bucket enrollment installs remote state without an upgrade prompt or legacy writes", async () => {
  const f = await remote(), source = db(); let active: Database | undefined;
  try {
    describeSelf(source, { app: "web", platform: "web", form: "browser", defaultLabel: "self" });
    addStoragePeer(source, { url, config });
    expect((await inspectBucketAccess(source, url, f.client, config)).kind).toBe("initializing");
    expect(needsBucketUpgrade(source, url)).toBe(false);
    ({ active } = await recover(source, { kind: "s3", url, config, client: f.client }));
    expect(getDocument(active, f.doc.id)?.body).toBe("current state");
    expect(readReplicaGeneration(active)?.incarnationId).not.toBe("server");
    expect(getNodeId(active)).toBe(getNodeId(source));
    expect(recoveryItems(active)).toEqual([]);
    expect(workspaceAccess(active)[0]?.kind).toBe("ready");
    await syncWithStorage(active, url, f.client, config);
    expect([...f.objects.keys()].some(key => /\/(oplog|snapshot|publisher)\//.test(key))).toBe(false);
  } finally { active?.close(); source.close(); f.server.close(); }
});

test("first connection to a verified empty bucket creates v2 directly with existing local content", async () => {
  const f = storage(), source = db(); let active: Database | undefined;
  try {
    const doc = createDocument(source, { title: "new workspace", body: "my content" });
    addStoragePeer(source, { url, config });
    ({ active } = await recover(source, { kind: "s3", url, config, client: f.client }));
    expect(getDocument(active, doc.id)?.body).toBe("my content");
    expect([...f.objects.keys()].every(key => key.includes("/v2/"))).toBe(true);
    expect(recoveryItems(active)).toEqual([]);
  } finally { active?.close(); source.close(); }
});

test("unknown, missing and legacy bucket layouts cannot silently initialize a new workspace", async () => {
  const f = storage(), source = db();
  try {
    f.client.getWithMetadata = async () => { throw new MhError("auth", "403"); };
    expect((await inspectBucketAccess(source, url, f.client, config)).kind).toBe("error");
    expect(f.objects.size).toBe(0);
    f.client.getWithMetadata = async () => null;
    f.objects.set("fixture/spaces/default/oplog/device/HEAD", { bytes: new Uint8Array(), lastModified: 1, serverDate: 1, etag: null });
    expect((await inspectBucketAccess(source, url, f.client, config)).kind).toBe("migration");
    expect(needsBucketUpgrade(source, url)).toBe(true);
  } finally { source.close(); }
});

test("populated legacy replicas require confirmation and retain their contents", async () => {
  const f = await remote(), source = db();
  try {
    const local = createDocument(source, { title: "offline", body: "keep me" }); addStoragePeer(source, { url, config });
    expect((await inspectBucketAccess(source, url, f.client, config)).kind).toBe("migration");
    await expect(recover(source, { kind: "s3", url, config, client: f.client })).rejects.toThrow("确认");
    expect(getDocument(source, local.id)?.body).toBe("keep me");
  } finally { source.close(); f.server.close(); }
});

test("HTTP bootstrap captures a consistent cursor, catches concurrent edits and never credits bucket coverage", async () => {
  const f = await remote(), source = db(); let active: Database | undefined;
  try {
    const url = "https://http.invalid"; addPeer(source, { url, token: "paired" });
    const target: WorkspaceTarget = { kind: "http", url, token: "paired", fetch: http(f.server, () => updateDocument(f.server, f.doc.id, { title: "edited during download" })) };
    ({ active } = await recover(source, target));
    expect(getDocument(active, f.doc.id)?.title).toBe("edited during download");
    expect(getPeer(active, url)?.pull_cursor).toBeGreaterThan(0);
    expect(readReplicaGeneration(active)?.incarnationId).not.toBe(readReplicaGeneration(f.server)?.incarnationId);
    expect(active.query("SELECT value FROM meta WHERE key='sync_v2_baseline_http'").get()).toEqual({ value: url });
    expect(active.query("SELECT 1 FROM meta WHERE key LIKE 'sync_v2_transport:%'").get()).toBeNull();
    expect(recoveryItems(active)).toEqual([]);
    await expect(syncWithStorage(active, "s3://later", f.client, config)).rejects.toMatchObject({ code: "rebootstrap_required" });
    const doc = createDocument(active, { title: "local after initialization", body: "works" });
    await syncWithPeer(active, url, { fetch: http(f.server) });
    expect(getDocument(f.server, doc.id)?.body).toBe("works");
  } finally { active?.close(); source.close(); f.server.close(); }
});

test("HTTP snapshot tampering and generation changes never activate the shadow", async () => {
  const f = await remote();
  try {
    for (const tampered of [true, false]) {
      const source = db(); const url = "https://http.invalid"; addPeer(source, { url });
      try {
        await expect(recover(source, { kind: "http", url, fetch: http(f.server, tampered ? undefined : () => {
          const generation = readReplicaGeneration(f.server)!;
          writeReplicaGeneration(f.server, { ...generation, epoch: generation.epoch + 1, checkpoint: "f".repeat(64) });
        }, tampered) })).rejects.toThrow();
        expect(source.query("SELECT 1 FROM meta WHERE key='local_recovery_successor'").get()).toBeNull();
      } finally { source.close(); }
    }
  } finally { f.server.close(); }
});

test("HTTP snapshot excludes private recovery items and rejects stale capture requests", async () => {
  const f = await remote();
  try {
    f.server.exec("CREATE TABLE sync_recovery_items(id TEXT,kind TEXT,target TEXT,local TEXT,remote TEXT,status TEXT,result TEXT); INSERT INTO sync_recovery_items VALUES('secret','draft','doc','private',NULL,'pending',NULL)");
    const request = { minSupportedDataVersion: 1, maxSupportedDataVersion: 2, workspaceId: "workspace", epoch: 0, checkpoint: f.root.checkpoint };
    const result = await captureHttpBootstrap(f.server, "server", request);
    expect(result.snapshot.current.pendingRecovery).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private");
    await expect(captureHttpBootstrap(f.server, "server", { ...request, epoch: 1 })).rejects.toMatchObject({ code: "rebootstrap_required" });
  } finally { f.server.close(); }
});
