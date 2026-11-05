/** Isolated native SQLite + crypto + v2 transport lifecycle. No user DB/config. */
import { ExpoDriver, nativeSqliteOpenOptions } from "../replica/expo-driver";
import type { NativeFaultRuntime } from "./native-faults";
import { initSchema } from "../../../../../src/core/schema-init";
import { createDocument, updateDocument, documentVersion, getDocument } from "../../../../../src/core/documents";
import { captureCurrentCheckpoint, installCurrentCheckpoint } from "../../../../../src/core/sync/current-checkpoint";
import { captureDocumentArchive } from "../../../../../src/core/history-archive";
import { createV2Bucket } from "../../../../../src/core/sync/bucket-v2";
import { writeReplicaGeneration } from "../../../../../src/core/sync/retention-protocol";
import { syncWithStorageV2 } from "../../../../../src/core/sync/storage-v2";
import { executeRetention, cleanRetiredV2Objects } from "../../../../../src/core/sync/retention-executor";
import { recoverV2Workspace, recoveryItems } from "../../../../../src/core/sync/recovery-v2";
import { MhError } from "../../../../../src/core/errors";
import type { StorageClient, StorageReadResult, S3Config } from "../../../../../src/core/sync/storage";
import { DAY_MS } from "../../../../../src/core/sync/retention-state";
import { generateMasterKey, toB64 } from "../../../../../src/core/sync/e2ee";

const requireTrue = (value: unknown, message: string) => { if (!value) throw new Error(`v2 native: ${message}`); };
export async function runNativeRetention(runtime?: NativeFaultRuntime): Promise<string[]> {
  if (!runtime) {
    const sqlite = await import("expo-sqlite");
    runtime = { open: name => sqlite.openDatabaseSync(name, nativeSqliteOpenOptions), remove: name => sqlite.deleteDatabaseSync(name) };
  }
  const prefix = `native-retention-isolated-${Date.now()}`;
  const names: string[] = [], opened: ExpoDriver[] = [];
  const open = () => {
    const name = `${prefix}-${names.length}.db`; names.push(name);
    const db = new ExpoDriver(runtime!.open(name)); initSchema(db); opened.push(db); return db;
  };
  const results: string[] = [], objects = new Map<string, StorageReadResult>();
  let now = Date.now();
  const client: StorageClient = {
    conditionalCreateCapability: async () => true,
    list: async () => { throw new Error("LIST is not a coverage proof"); },
    get: async key => objects.get(key)?.bytes ?? null,
    getWithMetadata: async key => { const object = objects.get(key); return object ? { ...object, serverDate: now } : null; },
    put: async (key, bytes, options) => {
      if (options?.ifNoneMatch && objects.has(key)) throw new MhError("conflict", "occupied");
      objects.set(key, { bytes: bytes.slice(), lastModified: ++now, serverDate: now, etag: null });
    },
    del: async key => { objects.delete(key); },
  };
  const config: S3Config = { endpoint: "https://isolated.invalid", bucket: "isolated", region: "test", prefix: "isolated", encrypt: true,
    masterKey: toB64(generateMasterKey()), accessKeyId: "synthetic", secretAccessKey: "synthetic" };
  try {
    const a = open(), b = open(), bucket = createV2Bucket(client, config);
    const doc = createDocument(a, { title: "synthetic", body: "deleted paragraph\n\nkept" });
    updateDocument(a, doc.id, { body: "kept" });
    const baseline = captureCurrentCheckpoint(a, "synthetic", 0);
    baseline.history.push({ documentId: doc.id, hash: await bucket.publish(captureDocumentArchive(a, "synthetic", doc.id)) });
    const root = await bucket.initialize(baseline);
    installCurrentCheckpoint(b, baseline, "synthetic");
    for (const [db, incarnationId] of [[a, "a"], [b, "b"]] as const)
      writeReplicaGeneration(db, { protocolVersion: 2, workspaceId: "synthetic", epoch: 0, checkpoint: root.checkpoint, incarnationId });
    const sync = (db: ExpoDriver) => syncWithStorageV2(db, client, config, { pushLimit: 1000 });
    await sync(a); await sync(b);
    const initialCount = (a.query("SELECT COUNT(*) AS n FROM doc_blocks").get() as { n: number }).n;
    for (let i = 0; i < 100; i++) updateDocument(a, doc.id, { body: `edit ${i}` }, { ifMatch: documentVersion(a, doc.id), preserveBlockIdentity: true });
    requireTrue((a.query("SELECT COUNT(*) AS n FROM doc_blocks").get() as { n: number }).n === initialCount, "100 edits changed block count");
    await sync(a); await sync(b);
    requireTrue(getDocument(b, doc.id)?.body === "edit 99", "remote edits missing");
    results.push("PASS v2 native encrypted SQLite replicas: 100 stable edits, one live block");
    updateDocument(a, doc.id, { body: "left" }, { ifMatch: documentVersion(a, doc.id), preserveBlockIdentity: true });
    updateDocument(b, doc.id, { body: "right" }, { ifMatch: documentVersion(b, doc.id), preserveBlockIdentity: true });
    await sync(a); await sync(b); await sync(a);
    requireTrue(recoveryItems(a).length && recoveryItems(b).length, "concurrent text lost");
    results.push("PASS v2 native same-block conflicts retain both texts");
    now += 29 * DAY_MS; await sync(a); await sync(b);
    now += 2 * DAY_MS; await sync(a); await sync(b); await sync(a);
    requireTrue((await executeRetention(a, client, config, { enabled: true })).status === "waiting_for_seals", "prepare missing");
    await sync(a); await sync(b); await sync(a);
    requireTrue((await executeRetention(a, client, config, { enabled: true })).status === "committed", "checkpoint missing");
    requireTrue((await cleanRetiredV2Objects(client, config, { enabled: true })).deleted === 0, "early deletion");
    now += 7 * DAY_MS;
    requireTrue((await cleanRetiredV2Objects(client, config, { enabled: true })).deleted > 0, "cleanup missing");
    let swapped = false;
    await recoverV2Workspace(b, client, config, "synthetic", {
      pauseAndFlush: async () => {}, protect: async () => ({ proof: "synthetic-original-db-retained" }), createShadow: async () => open(),
      swap: async shadow => { requireTrue(getDocument(shadow, doc.id)?.body === getDocument(a, doc.id)?.body, "current content changed"); swapped = true; },
      releaseShadow: async () => {}, resume: async () => {},
    });
    requireTrue(swapped, "recovery did not complete");
    results.push("PASS v2 native 30-day barrier, seven-day protection, cleanup and shadow rebootstrap");
    return results;
  } finally {
    for (const db of opened) db.close();
    for (const name of names) runtime.remove(name);
  }
}
