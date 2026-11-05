import { approveRetentionReport, maintainV2Workspace } from "./v2-maintenance.ts";
import { routes } from "./routes.ts";
import { syncWithPeer } from "./client.ts";
import { pendingPeerChanges } from "./peer-v2.ts";
import { getNodeId } from "../node.ts";
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { createDocument, updateDocument, getDocument, documentVersion } from "../documents.ts";
import { captureCurrentCheckpoint, installCurrentCheckpoint } from "./current-checkpoint.ts";
import { captureDocumentArchive } from "../history-archive.ts";
import { createV2Bucket } from "./bucket-v2.ts";
import { syncWithStorageV2 } from "./storage-v2.ts";
import { readReplicaGeneration, writeReplicaGeneration } from "./retention-protocol.ts";
import { executeRetention, cleanRetiredV2Objects, inspectRetention } from "./retention-executor.ts";
import { recoverV2Workspace, resolveRecoveryItem, recoveryItems } from "./recovery-v2.ts";
import { DAY_MS } from "./retention-state.ts";
import { MhError } from "../errors.ts";
import type { StorageClient, StorageReadResult, S3Config } from "./storage.ts";
function fixture() {
  const objects = new Map<string, StorageReadResult>();
  let now = Date.now();
  const client: StorageClient = {
    conditionalCreateCapability: async () => true,
    list: async () => { throw new Error("LIST cannot prove coverage"); },
    get: async key => objects.get(key)?.bytes ?? null,
    getWithMetadata: async key => { const value = objects.get(key); return value ? { ...value, serverDate: now } : null; },
    put: async (key, bytes, opts) => { if (opts?.ifNoneMatch && objects.has(key)) throw new MhError("conflict", "occupied"); objects.set(key, { bytes: bytes.slice(), lastModified: ++now, serverDate: now, etag: null }); },
    del: async key => { objects.delete(key); },
  };
  const config: S3Config = { endpoint: "https://test.invalid", bucket: "test", region: "test", prefix: "test", encrypt: true, masterKey: btoa("x".repeat(32)), accessKeyId: "test", secretAccessKey: "test" };
  const databases: Database[] = [];
  const db = () => { const db = new Database(":memory:"); runSchema(db); databases.push(db); return db; };
  const sync = (db: Database) => syncWithStorageV2(db, client, config);
  return { objects, client, config, db, sync, advance: (days: number) => { now += days * DAY_MS; }, close: () => databases.forEach(db => db.close()) };
}
test.each([false, true])("sealed checkpoint includes the last batch across cleanup and recovery (missing on first read: %s)", async missing => {
  const f = fixture();
  try {
    const a = f.db(), b = f.db(), old = f.db(), bucket = createV2Bucket(f.client, f.config);
    const doc = createDocument(a, { title: "document", body: "deleted paragraph\n\nretained paragraph" });
    updateDocument(a, doc.id, { body: "retained paragraph" });
    const baseline = captureCurrentCheckpoint(a, "workspace", 0);
    baseline.history.push({ documentId: doc.id, hash: await bucket.publish(captureDocumentArchive(a, "workspace", doc.id)) });
    const root = await bucket.initialize(baseline);
    for (const [db, member] of [[a, "a"], [b, "b"], [old, "old"]] as const) {
      if (db !== a) installCurrentCheckpoint(db, baseline, "workspace");
      writeReplicaGeneration(db, { protocolVersion: 2, workspaceId: "workspace", epoch: 0, incarnationId: member, checkpoint: root.checkpoint });
    }
    await f.sync(a); await f.sync(b); await f.sync(old);
    const offline = createDocument(old, { title: "offline edit", body: "must survive" });
    f.advance(29); await f.sync(a); await f.sync(b);
    expect((await inspectRetention(a, f.client, f.config)).candidates).toHaveLength(0);
    f.advance(2); await f.sync(a); await f.sync(b); await f.sync(a);
    expect((await executeRetention(a, f.client, f.config, { enabled: false })).status).toBe("dry_run");
    expect((await executeRetention(a, f.client, f.config, { enabled: true })).status).toBe("waiting_for_seals");
    await f.sync(a); await f.sync(a);
    const late = createDocument(b, { title: "late", body: "last confirmed batch" });
    let roots = 0;
    let missingKey = "", missingSequence = 0;
    const client: StorageClient = { ...f.client, getWithMetadata: async (key, options) => {
      if (key.endsWith("/root") && ++roots === 2) {
        await f.sync(b);
        await bucket.log(root).read(undefined, async record => {
          if (record.payload.type === "batch" && record.payload.member === "b") {
            missingKey = bucket.objectKey(record.payload.objectHash);
            missingSequence = record.sequence;
          }
        });
      }
      if (missing && key === missingKey) return null;
      return f.client.getWithMetadata!(key, options);
    } };
    if (missing) {
      await expect(executeRetention(a, client, f.config, { enabled: true })).rejects.toMatchObject({ code: "busy" });
      const progress = a.query("SELECT value FROM meta WHERE key='sync_v2_transport:a'").get() as { value: string };
      expect(JSON.parse(progress.value).applied).toBe(missingSequence - 1);
      expect((await bucket.log(root).read()).state.checkpoint).toBe(root.checkpoint);
      expect(getDocument(a, late.id)).toBeNull();
      await f.sync(a);
    }
    const result = await executeRetention(a, missing ? f.client : client, f.config, { enabled: true });
    expect(result.status).toBe("committed");
    expect((await cleanRetiredV2Objects(f.client, f.config, { enabled: true })).deleted).toBe(0);
    await expect(f.sync(old)).rejects.toMatchObject({ code: "rebootstrap_required" });
    f.advance(7);
    expect((await cleanRetiredV2Objects(f.client, f.config, { enabled: true })).deleted).toBeGreaterThan(0);
    let replacement: Database | null = null;
    const recovery = await recoverV2Workspace(old, f.client, f.config, "workspace", {
      pauseAndFlush: async () => {}, protect: async () => ({ proof: "verified-test-backup" }),
      createShadow: async () => f.db(), swap: async shadow => { replacement = shadow as Database; },
      releaseShadow: async () => {}, resume: async () => {},
    });
    expect(getDocument(replacement!, late.id)?.body).toBe(late.body);
    expect(recovery.pending).toBeGreaterThan(0);
    expect(getDocument(replacement!, doc.id)?.body).toBe("retained paragraph");
    expect(readReplicaGeneration(replacement!)?.epoch).toBe(1);
    const item = recoveryItems(replacement!).find(item => item.target === offline.id)!;
    const copy = resolveRecoveryItem(replacement!, item.id, "copy");
    expect(getDocument(replacement!, copy!)?.body).toBe("must survive");
    expect(resolveRecoveryItem(replacement!, item.id, "copy")).toBe(copy);
    await f.sync(replacement!);
    expect(getDocument(old, offline.id)?.body).toBe("must survive");
  } finally { f.close(); }
});
test("protection/low-space failure never creates root or swaps the original database", async () => {
  const f = fixture();
  try {
    const db = f.db(), doc = createDocument(db, { title: "safe", body: "unpublished" });
    let swapped = false, resumed = false;
    await expect(recoverV2Workspace(db, f.client, f.config, "workspace", {
      pauseAndFlush: async () => {}, protect: async () => { throw new Error("SQLITE_FULL"); }, createShadow: async () => f.db(),
      swap: async () => { swapped = true; }, releaseShadow: async () => {}, resume: async () => { resumed = true; },
    })).rejects.toThrow("SQLITE_FULL");
    expect(swapped).toBe(false); expect(resumed).toBe(true); expect(f.objects.size).toBe(0);
    expect(getDocument(db, doc.id)?.body).toBe("unpublished");
  } finally { f.close(); }
});
test("same-block edits preserve both conflicting texts and ordinary edits keep identity", async () => {
  const f = fixture();
  try {
    const a = f.db(), b = f.db(), bucket = createV2Bucket(f.client, f.config);
    const doc = createDocument(a, { title: "shared", body: "baseline" });
    const checkpoint = captureCurrentCheckpoint(a, "workspace", 0), root = await bucket.initialize(checkpoint);
    installCurrentCheckpoint(b, checkpoint, "workspace");
    for (const [db, incarnationId] of [[a, "a"], [b, "b"]] as const)
      writeReplicaGeneration(db, { protocolVersion: 2, workspaceId: "workspace", epoch: 0, checkpoint: root.checkpoint, incarnationId });
    await f.sync(a); await f.sync(b);
    updateDocument(a, doc.id, { body: "left edit" }, { ifMatch: documentVersion(a, doc.id), preserveBlockIdentity: true });
    updateDocument(b, doc.id, { body: "right edit" }, { ifMatch: documentVersion(b, doc.id), preserveBlockIdentity: true });
    await f.sync(a); await f.sync(b); await f.sync(a);
    for (const db of [a, b]) {
      expect((db.query("SELECT count(*) AS n FROM doc_blocks WHERE __deleted=0").get() as { n: number }).n).toBe(1);
      const winner = getDocument(db, doc.id)!.body;
      const copies = recoveryItems(db).map(item => getDocument(db, resolveRecoveryItem(db, item.id, "copy")!)!.body);
      expect(copies).toContain(winner === "left edit" ? "right edit" : "left edit");

    }
  } finally { f.close(); }
});


test("replaying 100 sequential stable edits does not invent concurrent conflicts", async () => {
  const f = fixture();
  try {
    const a = f.db(), b = f.db(), bucket = createV2Bucket(f.client, f.config);
    const doc = createDocument(a, { title: "sequential", body: "baseline" });
    const checkpoint = captureCurrentCheckpoint(a, "workspace", 0), root = await bucket.initialize(checkpoint);
    installCurrentCheckpoint(b, checkpoint, "workspace");
    for (const [db, incarnationId] of [[a, "a"], [b, "b"]] as const)
      writeReplicaGeneration(db, { protocolVersion: 2, workspaceId: "workspace", epoch: 0, checkpoint: root.checkpoint, incarnationId });
    await f.sync(a); await f.sync(b);
    for (let i = 0; i < 100; i++) updateDocument(a, doc.id, { body: `sequential ${i}` }, { ifMatch: documentVersion(a, doc.id) });
    await f.sync(a); await f.sync(a); await f.sync(b);
    expect(recoveryItems(a)).toHaveLength(0);
    expect(recoveryItems(b)).toHaveLength(0);
    expect(getDocument(b, doc.id)?.body).toBe("sequential 99");
    expect(a.query("SELECT count(*) AS n FROM doc_blocks WHERE __deleted=1").get()).toEqual({ n: 0 });
  } finally { f.close(); }
});


test("intentional deletion does not turn its own preceding edits into recovery conflicts", async () => {
  const f = fixture();
  try {
    const a = f.db(), b = f.db(), bucket = createV2Bucket(f.client, f.config);
    const doc = createDocument(a, { title: "delete sequence", body: "baseline" });
    const cp = captureCurrentCheckpoint(a, "workspace", 0), root = await bucket.initialize(cp);
    installCurrentCheckpoint(b, cp, "workspace");
    for (const [db, incarnationId] of [[a, "a"], [b, "b"]] as const)
      writeReplicaGeneration(db, { protocolVersion: 2, workspaceId: "workspace", epoch: 0, checkpoint: root.checkpoint, incarnationId });
    await f.sync(a); await f.sync(b);
    updateDocument(a, doc.id, { body: "edited then deleted" }, { ifMatch: documentVersion(a, doc.id) });
    updateDocument(a, doc.id, { body: "" }, { ifMatch: documentVersion(a, doc.id) });
    await f.sync(a); await f.sync(b); await f.sync(a);
    expect(recoveryItems(a)).toHaveLength(0); expect(recoveryItems(b)).toHaveLength(0);
    expect(getDocument(b, doc.id)?.body).toBe("");
  } finally { f.close(); }
});


test("delete versus offline edit preserves the editor's text on both replicas", async () => {
  const f = fixture();
  try {
    const a = f.db(), b = f.db(), bucket = createV2Bucket(f.client, f.config);
    const doc = createDocument(a, { title: "delete race", body: "baseline" });
    const cp = captureCurrentCheckpoint(a, "workspace", 0), root = await bucket.initialize(cp);
    installCurrentCheckpoint(b, cp, "workspace");
    for (const [db, incarnationId] of [[a, "a"], [b, "b"]] as const)
      writeReplicaGeneration(db, { protocolVersion: 2, workspaceId: "workspace", epoch: 0, checkpoint: root.checkpoint, incarnationId });
    await f.sync(a); await f.sync(b);
    updateDocument(a, doc.id, { body: "" }, { ifMatch: documentVersion(a, doc.id) });
    updateDocument(b, doc.id, { body: "offline content must survive deletion" }, { ifMatch: documentVersion(b, doc.id) });
    await f.sync(a); await f.sync(b); await f.sync(a);
    for (const db of [a,b]) {
      expect(getDocument(db, doc.id)?.body).toBe("");
      expect(JSON.stringify(recoveryItems(db))).toContain("offline content must survive deletion");
    }
  } finally { f.close(); }
});

test("recovery automatically replays uncontested text and preserves changes to other blocks", async () => {
  const f = fixture();
  try {
    const a = f.db(), b = f.db(), bucket = createV2Bucket(f.client, f.config);
    const doc = createDocument(a, { title: "shared", body: "first\n\nsecond" });
    const checkpoint = captureCurrentCheckpoint(a, "workspace", 0), root = await bucket.initialize(checkpoint);
    installCurrentCheckpoint(b, checkpoint, "workspace");
    for (const [db, incarnationId] of [[a,"a"],[b,"b"]] as const)
      writeReplicaGeneration(db, { protocolVersion: 2, workspaceId: "workspace", epoch: 0, checkpoint: root.checkpoint, incarnationId });
    await f.sync(a); await f.sync(b);
    updateDocument(a, doc.id, { body: "first\n\nremote second" }, { ifMatch: documentVersion(a,doc.id) });
    await f.sync(a);
    updateDocument(b, doc.id, { body: "offline first\n\nsecond" }, { ifMatch: documentVersion(b,doc.id) });
    updateDocument(b, doc.id, { body: "offline first final\n\nsecond" }, { ifMatch: documentVersion(b,doc.id) });
    let replacement: Database | null = null;
    const result = await recoverV2Workspace(b, f.client, f.config, "workspace", {
      pauseAndFlush: async () => {}, protect: async () => ({ proof: "verified" }), createShadow: async () => f.db(),
      swap: async db => { replacement = db as Database; }, releaseShadow: async () => {}, resume: async () => {},
    });
    expect(result.pending).toBe(0);
    expect(getDocument(replacement!,doc.id)?.body).toBe("offline first final\n\nremote second");
    await f.sync(replacement!); await f.sync(a);
    expect(getDocument(a,doc.id)?.body).toBe("offline first final\n\nremote second");
    expect(recoveryItems(a)).toHaveLength(0);
  } finally { f.close(); }
});

test("shadow release failure still resumes the original session", async () => {
  const f = fixture();
  try {
    const db = f.db(); createDocument(db, { title: "safe", body: "text" });
    let resumed = false;
    await expect(recoverV2Workspace(db, f.client, f.config, "workspace", {
      pauseAndFlush: async () => {}, protect: async () => ({ proof: "verified" }), createShadow: async () => f.db(),
      swap: async () => { throw new Error("swap failed"); }, releaseShadow: async () => { throw new Error("close failed"); },
      resume: async () => { resumed = true; },
    })).rejects.toThrow("close failed");
    expect(resumed).toBe(true);
  } finally { f.close(); }
});

test("checkpoint with forged source coverage cannot bootstrap a replica", async () => {
  const f = fixture();
  try {
    const db = f.db(), bucket = createV2Bucket(f.client, f.config);
    createDocument(db, { title: "safe", body: "text" });
    const initial = captureCurrentCheckpoint(db,"workspace",0), root = await bucket.initialize(initial);
    const log = bucket.log(root);
    await log.append("join", () => ({ type: "join", epoch: 0, member: "a", checkpoint: root.checkpoint }));
    await log.append("prepare", () => ({ type: "prepare", epoch: 0, id: "gc" }));
    const sealed = await log.append("seal", () => ({ type: "seal", epoch: 0, id: "gc", member: "a", sequence: 0 }));
    const invalid = { ...initial, epoch: 1, coveredSequence: sealed.sequence, sourceCoverage: { a: 12 } };
    const digest = await bucket.publish(invalid);
    await log.append("commit", () => ({ type: "commit", epoch: 0, id: "gc", checkpoint: digest }));
    await expect(bucket.checkpointFor(root, digest, 1)).rejects.toThrow("source coverage proof");
  } finally { f.close(); }
});

test("remaining tombstone keeps its original confirmed age across checkpoint epochs", async () => {
  const f = fixture();
  try {
    const a = f.db(), bucket = createV2Bucket(f.client,f.config);
    const first = createDocument(a,{ title: "first", body: "delete first" });
    const second = createDocument(a,{ title: "second", body: "delete later" });
    updateDocument(a,first.id,{ body: "" });
    const initial = captureCurrentCheckpoint(a,"workspace",0), root = await bucket.initialize(initial);
    writeReplicaGeneration(a,{ protocolVersion: 2, workspaceId: "workspace", epoch: 0, incarnationId: "a", checkpoint: root.checkpoint });
    await f.sync(a);
    f.advance(20); await f.sync(a);
    updateDocument(a,second.id,{ body: "" },{ ifMatch: documentVersion(a,second.id) }); await f.sync(a);
    const lateId = (a.query("SELECT id FROM doc_blocks WHERE doc_id=? AND __deleted=1").get(second.id) as { id: string }).id;
    const observed = (await inspectRetention(a,f.client,f.config)).deletionTimes[lateId];
    f.advance(11); await f.sync(a); await f.sync(a);
    expect((await executeRetention(a,f.client,f.config,{ enabled: true })).status).toBe("waiting_for_seals");
    await f.sync(a); await f.sync(a);
    expect((await executeRetention(a,f.client,f.config,{ enabled: true })).status).toBe("committed");
    let replacement: Database | null = null;
    await recoverV2Workspace(a,f.client,f.config,"workspace",{
      pauseAndFlush: async () => {}, protect: async () => ({ proof: "verified" }), createShadow: async () => f.db(),
      swap: async db => { replacement = db as Database; }, releaseShadow: async () => {}, resume: async () => {},
    });
    await f.sync(replacement!);
    f.advance(20); await f.sync(replacement!);
    const report = await inspectRetention(replacement!,f.client,f.config);
    expect(report.deletionTimes[lateId]).toBe(observed);
    expect(report.candidates).toContain(lateId);
  } finally { f.close(); }
});


test("HTTP v2 conflicts stay recoverable and peer delivery is not bucket coverage", async () => {
  const f = fixture();
  try {
    const a = f.db(), b = f.db(), bucket = createV2Bucket(f.client,f.config);
    const doc = createDocument(a,{ title: "shared", body: "baseline" });
    const checkpoint = captureCurrentCheckpoint(a,"workspace",0), root = await bucket.initialize(checkpoint);
    installCurrentCheckpoint(b,checkpoint,"workspace");
    for (const [db,incarnationId] of [[a,"a"],[b,"b"]] as const)
      writeReplicaGeneration(db,{ protocolVersion: 2, workspaceId: "workspace", epoch: 0, incarnationId, checkpoint: root.checkpoint });
    await f.sync(a); await f.sync(b);
    updateDocument(a,doc.id,{ body: "left peer" },{ ifMatch: documentVersion(a,doc.id) });
    updateDocument(b,doc.id,{ body: "right peer" },{ ifMatch: documentVersion(b,doc.id) });
    const fetchPeer = (async (url: string | URL | Request, init?: RequestInit) => {
      const req = new Request(String(url),init);
      return routes.find(route => route.path === new URL(req.url).pathname && route.method === req.method)!.handler(req,{ db: b, node: getNodeId(b) });
    }) as typeof fetch;
    await syncWithPeer(a,"https://synthetic.invalid",{ fetch: fetchPeer });
    for (const db of [a,b]) {
      const preserved = JSON.stringify(recoveryItems(db)) + getDocument(db,doc.id)!.body;
      expect(preserved).toContain("left peer"); expect(preserved).toContain("right peer");
      expect(pendingPeerChanges(db).length).toBeGreaterThan(0);
      expect((await inspectRetention(db,f.client,f.config)).reason).toContain("对等同步");
    }
    await f.sync(a); await f.sync(b); await f.sync(a);
    expect(pendingPeerChanges(a)).toHaveLength(0); expect(pendingPeerChanges(b)).toHaveLength(0);
  } finally { f.close(); }
});


test("rebuilding again preserves pending recovery and explicit discard decisions", async () => {
  const f = fixture();
  try {
    const db = f.db(); createDocument(db,{ title: "baseline", body: "text" });
    recoveryItems(db);
    db.query("INSERT INTO sync_recovery_items(id,kind,target,local,remote) VALUES('keep','document','missing',?,NULL)").run(JSON.stringify({ title: "keep", body: "offline text" }));
    db.query("INSERT INTO sync_recovery_items(id,kind,target,local,remote) VALUES('discard','document','missing',?,NULL)").run(JSON.stringify({ body: "discarded text" }));
    resolveRecoveryItem(db,"discard","discard");
    let current = db;
    for (let round = 0; round < 2; round++) {
      await recoverV2Workspace(current,f.client,f.config,"workspace",{
        pauseAndFlush: async () => {}, protect: async () => ({ proof: "verified" }), createShadow: async () => f.db(),
        swap: async shadow => { current = shadow as Database; }, releaseShadow: async () => {}, resume: async () => {},
      });
      expect(recoveryItems(current).map(item => item.id)).toEqual(["keep"]);
      expect(current.query("SELECT status FROM sync_recovery_items WHERE id='discard'").get()).toEqual({ status: "discarded" });
    }
    expect(current.query("SELECT COUNT(*) AS n FROM sync_recovery_packages").get()).toEqual({ n: 2 });
  } finally { f.close(); }
});


test("reviewed maintenance survives rebootstrap and performs delayed cleanup", async () => {
  const f = fixture();
  try {
    const db = f.db(), bucket = createV2Bucket(f.client,f.config);
    const doc = createDocument(db,{ title: "retention", body: "deleted text" }); updateDocument(db,doc.id,{ body: "" });
    const root = await bucket.initialize(captureCurrentCheckpoint(db,"workspace",0));
    writeReplicaGeneration(db,{ protocolVersion: 2, workspaceId: "workspace", epoch: 0, incarnationId: "a", checkpoint: root.checkpoint });
    await f.sync(db); f.advance(31); await f.sync(db); await f.sync(db);
    const report = await inspectRetention(db,f.client,f.config);
    expect(() => approveRetentionReport(db,{ ...report, checkpoint: "0".repeat(64) })).toThrow("no longer current");
    expect((await bucket.log(root).read()).state.epoch).toBe(0);
    approveRetentionReport(db,report);
    await maintainV2Workspace(db,f.client,f.config);
    await f.sync(db); await f.sync(db);
    expect((await bucket.log(root).read()).state.epoch).toBe(1);
    expect(f.objects.has(bucket.objectKey(root.checkpoint))).toBe(true);
    let current: Database | null = null;
    await recoverV2Workspace(db,f.client,f.config,"workspace",{
      pauseAndFlush: async () => {}, protect: async () => ({ proof: "verified" }), createShadow: async () => f.db(),
      swap: async shadow => { current = shadow as Database; }, releaseShadow: async () => {}, resume: async () => {},
    });
    expect(current!.query("SELECT 1 FROM meta WHERE key='sync_v2_retention_review'").get()).not.toBeNull();
    await f.sync(current!); f.advance(7); await f.sync(current!);
    expect(f.objects.has(bucket.objectKey(root.checkpoint))).toBe(false);
  } finally { f.close(); }
});

test("simultaneous in-place migration keeps each device's original content recoverable", async () => {
  const f = fixture();
  try {
    const sources = [f.db(),f.db()], replacements: Database[] = [];
    for (let i = 0; i < sources.length; i++) createDocument(sources[i]!,{ title: `device ${i}`,body: `original device ${i}` });
    await Promise.all(sources.map((source,i) => recoverV2Workspace(source,f.client,f.config,"workspace",{
      pauseAndFlush: async () => {}, protect: async () => ({ proof: `verified-${i}` }), createShadow: async () => f.db(),
      swap: async db => { replacements[i] = db as Database; }, releaseShadow: async () => {}, resume: async () => {},
    })));
    const root = (await createV2Bucket(f.client,f.config).root())!;
    for (let i = 0; i < replacements.length; i++) {
      expect(readReplicaGeneration(replacements[i]!)?.checkpoint).toBe(root.checkpoint);
      const preserved = JSON.stringify(replacements[i]!.query("SELECT body FROM documents WHERE __deleted=0").all()) + JSON.stringify(recoveryItems(replacements[i]!));
      expect(preserved).toContain(`original device ${i}`);
      expect(sources[i]!.query("SELECT COUNT(*) AS n FROM documents WHERE __deleted=0").get()).toEqual({ n: 1 });
    }
  } finally { f.close(); }
});

test("competing collectors produce one accepted epoch transition", async () => {
  const f = fixture();
  try {
    const a = f.db(), b = f.db(), bucket = createV2Bucket(f.client,f.config);
    const doc = createDocument(a,{ title: "deleted", body: "old text" }); updateDocument(a,doc.id,{ body: "" });
    const checkpoint = captureCurrentCheckpoint(a,"workspace",0), root = await bucket.initialize(checkpoint);
    installCurrentCheckpoint(b,checkpoint,"workspace");
    for (const [db,incarnationId] of [[a,"a"],[b,"b"]] as const)
      writeReplicaGeneration(db,{ protocolVersion: 2, workspaceId: "workspace", epoch: 0, incarnationId, checkpoint: root.checkpoint });
    await f.sync(a); await f.sync(b); f.advance(29); await f.sync(a); await f.sync(b);
    f.advance(2); await f.sync(a); await f.sync(b); await f.sync(a); await f.sync(b);
    await Promise.allSettled([a,b].map(db => executeRetention(db,f.client,f.config,{ enabled: true })));
    await f.sync(a); await f.sync(b); await f.sync(a); await f.sync(b);
    const outcomes = await Promise.allSettled([a,b].map(db => executeRetention(db,f.client,f.config,{ enabled: true })));
    expect(outcomes.some(outcome => outcome.status === "fulfilled" && outcome.value.status === "committed")).toBe(true);
    let commits = 0;
    const head = await bucket.log(root).read(undefined,async (record,_,rejected) => { if (!rejected && record.payload.type === "commit") commits++; });
    expect(head.state.epoch).toBe(1); expect(commits).toBe(1);
    await bucket.checkpointFor(root,head.state.checkpoint!,head.state.epoch);
  } finally { f.close(); }
});

test("recovery retains offline reparent intent", async () => {
  const f = fixture();
  try {
    const a = f.db(), b = f.db(), bucket = createV2Bucket(f.client, f.config);
    const doc = createDocument(a, { title: "shared", body: "first\n\nsecond" });
    const checkpoint = captureCurrentCheckpoint(a, "workspace", 0), root = await bucket.initialize(checkpoint);
    installCurrentCheckpoint(b, checkpoint, "workspace");
    for (const [db, incarnationId] of [[a,"a"],[b,"b"]] as const)
      writeReplicaGeneration(db, { protocolVersion: 2, workspaceId: "workspace", epoch: 0, checkpoint: root.checkpoint, incarnationId });
    await f.sync(a); await f.sync(b);
    const parent = createDocument(a, { title: "parent" });
    updateDocument(a, doc.id, { parent_id: parent.id });
    await f.sync(a); await f.sync(b);
    updateDocument(b, doc.id, { parent_id: null, database_id: "offline-db", body: "offline body" });
    let replacement: Database | null = null;
    const result = await recoverV2Workspace(b, f.client, f.config, "workspace", {
      pauseAndFlush: async () => {}, protect: async () => ({ proof: "verified" }), createShadow: async () => f.db(),
      swap: async db => { replacement = db as Database; }, releaseShadow: async () => {}, resume: async () => {},
    });
    expect(result.pending).toBeGreaterThan(0);
    const items = recoveryItems(replacement!);
    const structure = items.find(item => item.kind === "entity")!;
    expect(JSON.parse(structure.local).fields).toMatchObject({ parent_id: null, database_id: "offline-db" });
    expect(items.some(item => JSON.parse(item.local).body === "offline body")).toBe(true);
    const copy = resolveRecoveryItem(replacement!, structure.id, "copy")!;
    expect(getDocument(replacement!, copy)!.body).toContain("offline-db");
  } finally { f.close(); }
});

test("legacy block copies use surviving version evidence and preserve both alternatives when ambiguous", () => {
  const f = fixture();
  try {
    const db = f.db();
    const doc = createDocument(db, { title: "legacy", body: "first" });
    updateDocument(db, doc.id, { body: "second" }, { ifMatch: documentVersion(db, doc.id), preserveBlockIdentity: true });
    const row = db.query("SELECT row_id, hlc FROM crdt_changes WHERE dataset='doc_blocks' AND col='text' ORDER BY hlc DESC LIMIT 1").get() as { row_id: string; hlc: string };
    recoveryItems(db);
    for (const [hlc, expected] of [[row.hlc, "first"], ["unknown", "版本一\nsecond\n\n版本二\nfirst"]] as const) {
      const id = `workspace:${hlc}:${row.row_id}:text`;
      db.query("INSERT INTO sync_recovery_items(id,kind,target,local,remote) VALUES(?,?,?,?,?)")
        .run(id, "block", row.row_id, JSON.stringify({ title: "段落编辑冲突", body: "second" }), JSON.stringify({ body: "first" }));
      expect(JSON.parse(recoveryItems(db)[0]!.local).body).toBe(expected);
      const copy = resolveRecoveryItem(db, id, "copy")!;
      expect(getDocument(db, copy)!.body).toBe(expected);
      expect(resolveRecoveryItem(db, id, "copy")).toBe(copy);
    }
  } finally { f.close(); }
});

test("migration reconciles covered entity history and pending items from earlier upgrades", async () => {
  const f = fixture();
  try {
    const source = f.db();
    const { emit } = await import("../crdt.ts");
    const fields = [emit(source, "databases", "db", "title", "old"), emit(source, "databases", "db", "title", "new")];
    recoveryItems(source);
    const save = (id: string, changes: unknown[]) => source.query(
      "INSERT INTO sync_recovery_items(id,kind,target,local) VALUES(?,'entity','db',?)"
    ).run(id, JSON.stringify({ changes }));
    save("covered", fields);
    save("divergent", [{ ...fields[1], value: '"offline"' }]);
    save("unknown", [{}]);
    const shadow = f.db();
    const result = await recoverV2Workspace(source, f.client, f.config, "workspace", {
      pauseAndFlush: async () => {}, protect: async () => ({ proof: "verified" }), createShadow: async () => shadow,
      swap: async () => {}, releaseShadow: async () => {}, resume: async () => {},
    });
    expect(result.pending).toBe(2);
    expect(recoveryItems(shadow).map(i => i.id)).toEqual(["divergent", "unknown"]);
    expect(shadow.query("SELECT status FROM sync_recovery_items WHERE id='covered'").get()).toEqual({ status: "matched" });
  } finally { f.close(); }
});
