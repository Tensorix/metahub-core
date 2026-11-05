import { pendingPeerChanges } from "./peer-v2.ts";
import { restoreUncontestedText } from "./recovery-intent.ts";
import { observeHistory } from "./history-observation.ts";
import { changesAfterSeq } from "../crdt.ts";
import { getNodeId } from "../node.ts";
import { ingestV2Batch } from "./v2-ingest.ts";
import type { DbDriver } from "../driver.ts";
import { writeTx } from "../driver.ts";
import { createV2Bucket } from "./bucket-v2.ts";
import type { StorageClient, S3Config } from "./storage.ts";
import { captureCurrentCheckpoint, installCurrentCheckpoint } from "./current-checkpoint.ts";
import { splitDocumentArchive, captureDocumentArchive, DocumentArchiveSchema, installDocumentArchive } from "../history-archive.ts";
import { readReplicaGeneration, writeReplicaGeneration } from "./retention-protocol.ts";
import { createDocument, getDocument } from "../documents.ts";
import { MhError } from "../errors.ts";
import { commitHash } from "./commit-log.ts";

export type RecoveryPhase = "saving" | "protecting" | "downloading" | "verifying" | "swapping" | "pending";
export interface RecoveryItem { id: string; kind: string; target: string; local: string; remote: string | null; status: string; result: string | null }
function schema(db: DbDriver) {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_recovery_items (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, local TEXT NOT NULL,
    remote TEXT, status TEXT NOT NULL DEFAULT 'pending', result TEXT);
    CREATE TABLE IF NOT EXISTS sync_recovery_packages (id TEXT PRIMARY KEY, proof TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending');`);
}
export function recoveryItems(db: DbDriver): RecoveryItem[] {
  schema(db);
  return db.query("SELECT * FROM sync_recovery_items WHERE status='pending' ORDER BY id").all() as RecoveryItem[];
}
/** Explicit user decisions are idempotent. No TTL deletes unresolved items. */
export function resolveRecoveryItem(db: DbDriver, id: string, action: "copy" | "discard"): string | null {
  schema(db);
  return writeTx(db, () => {
    const item = db.query("SELECT * FROM sync_recovery_items WHERE id=?").get(id) as RecoveryItem | null;
    if (!item) throw new MhError("not_found", "recovery item not found");
    if (item.status !== "pending") return item.result;
    let result: string | null = null;
    if (action === "copy") {
      const local = JSON.parse(item.local);
      // Non-document changes remain available as a readable recovery document;
      // they must not be replayed with obsolete identities or transport cursors.
      result = createDocument(db, { title: `${local.title ?? item.target} · 恢复副本`,
        body: typeof local.body === "string" ? local.body : `\`\`\`json\n${JSON.stringify(local, null, 2)}\n\`\`\`` }).id;
    }
    db.query("UPDATE sync_recovery_items SET status=?,result=? WHERE id=?").run(action === "copy" ? "restored" : "discarded", result, id);
    return result;
  });
}

export interface RecoveryAdapter {
  /** Flush every active editor then quiesce mutations and old transport. */
  pauseAndFlush(): Promise<void>;
  /** Durable consistent database + drafts + unpublished attachment bytes.
   * Must read back and verify the saved package before returning its proof. */
  protect(id: string): Promise<{ proof: string }>;
  createShadow(id: string): Promise<DbDriver>;
  /** Persist the active-database pointer atomically; old package stays intact. */
  swap(shadow: DbDriver, id: string): Promise<void>;
  releaseShadow(shadow: DbDriver, committed: boolean): Promise<void>;
  resume(): Promise<void>;
  phase?(phase: RecoveryPhase): void;
}
/** Transaction boundary across runtimes. No old database is reset in place.
 * Adapter failures before swap leave the original database available. */
export async function recoverV2Workspace(source: DbDriver, client: StorageClient, config: S3Config, workspaceId: string, adapter: RecoveryAdapter) {
  const id = crypto.randomUUID();
  let shadow: DbDriver | null = null, committed = false;
  const phase = (value: RecoveryPhase) => adapter.phase?.(value);
  phase("saving");
  try {
    await adapter.pauseAndFlush();
    phase("protecting");
    const protection = await adapter.protect(id);
    if (!protection.proof) throw new MhError("invalid_input", "recovery protection was not verified");
    const bucket = createV2Bucket(client, config);
    let root = await bucket.root();
    if (!root) {
      const checkpoint = captureCurrentCheckpoint(source, workspaceId, 0);
      for (const row of source.query("SELECT id FROM documents ORDER BY id").all() as { id: string }[]) {
        const archive = captureDocumentArchive(source, workspaceId, row.id);
        for (const part of splitDocumentArchive(archive)) checkpoint.history.push({ documentId: row.id, hash: await bucket.publish(part) });
      }
      root = await bucket.initialize(checkpoint);
    }
    const oldGeneration = readReplicaGeneration(source);
    if (oldGeneration && oldGeneration.workspaceId !== root.workspaceId)
      throw new MhError("invalid_input", "recovery cannot switch workspace identities");
    phase("downloading");
    const log = bucket.log(root), head = await log.read();
    const checkpoint = await bucket.checkpointFor(root, head.state.checkpoint!, head.state.epoch);
    shadow = await adapter.createShadow(id);
    installCurrentCheckpoint(shadow, checkpoint, root.workspaceId);
    // Replay only records beyond checkpoint coverage. Old data objects may have
    // been collected; compact control metadata remains readable indefinitely.

    await log.read(undefined, async (record, after, rejected) => {
      if (rejected || record.sequence <= checkpoint.coveredSequence || record.payload.type !== "batch") return;
      const batch = await bucket.batchFor(root!, record.payload);
      const result = ingestV2Batch(shadow!, batch);
      observeHistory(shadow!, batch.changes, after.serverTime!);
      if (result.poisoned || Object.values(result.skewed).some(n => n > 0)) throw new MhError("clock_skew", "recovery rejected remote data");
    });
    phase("verifying");
    schema(shadow);
    const retentionReview = source.query("SELECT value FROM meta WHERE key='sync_v2_retention_review'").get() as { value: string } | null;
    if (retentionReview) {
      try {
        if (JSON.parse(retentionReview.value).workspaceId === root.workspaceId)
          shadow.query("INSERT OR REPLACE INTO meta(key,value) VALUES('sync_v2_retention_review',?)").run(retentionReview.value);
      } catch { /* Old checkpoint-specific approvals cannot authorize a new epoch. */ }
    }
    // Local recovery decisions and package references survive every rebuild.
    // A cloud checkpoint cannot resurrect an item already explicitly resolved
    // on this device, nor silently drop locally discovered conflicts.
    if (source.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_recovery_items'").get()) {
      for (const item of source.query("SELECT * FROM sync_recovery_items").all() as RecoveryItem[])
        shadow.query("INSERT OR REPLACE INTO sync_recovery_items(id,kind,target,local,remote,status,result) VALUES(?,?,?,?,?,?,?)")
          .run(item.id,item.kind,item.target,item.local,item.remote,item.status,item.result);
    }
    if (source.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_recovery_packages'").get()) {
      for (const pkg of source.query("SELECT * FROM sync_recovery_packages").all() as { id: string; proof: string; status: string }[])
        shadow.query("INSERT OR IGNORE INTO sync_recovery_packages(id,proof,status) VALUES(?,?,?)").run(pkg.id,pkg.proof,pkg.status);
    }
    writeReplicaGeneration(shadow, { protocolVersion: 2, workspaceId: root.workspaceId, epoch: head.state.epoch,
      checkpoint: head.state.checkpoint, incarnationId: crypto.randomUUID() });
    shadow.query("INSERT INTO sync_recovery_packages(id,proof) VALUES(?,?)").run(id, protection.proof);
    // Durable intent records are separate from the old oplog. Conservative
    // copies preserve edits when a common baseline is unavailable.
    const sourceTransport = oldGeneration ? source.query("SELECT value FROM meta WHERE key=?").get(`sync_v2_transport:${oldGeneration.incarnationId}`) as { value: string } | null : null;
    const pending = [...changesAfterSeq(source, sourceTransport ? JSON.parse(sourceTransport.value).cursor : 0, { onlyNode: getNodeId(source) }).changes, ...pendingPeerChanges(source)];
    const changedDocuments = new Set(pending.filter(c => c.dataset === "documents").map(c => c.row_id));
    for (const c of pending) if (c.dataset === "doc_blocks") {
      const owner = source.query("SELECT doc_id FROM doc_blocks WHERE id=?").get(c.row_id) as { doc_id: string | null } | null;
      if (owner?.doc_id) changedDocuments.add(owner.doc_id);
    }
    const candidates = (source.query("SELECT id FROM documents WHERE __deleted=0 ORDER BY id").all() as { id: string }[])
      .filter(row => !sourceTransport || changedDocuments.has(row.id));
    const otherIntents = new Map<string, typeof pending>();
    for (const change of pending) {
      if (change.dataset === "doc_blocks" || (change.dataset === "documents" && candidates.some(row => row.id === change.row_id))) continue;
      const key = JSON.stringify([change.dataset, change.row_id]);
      otherIntents.set(key, [...(otherIntents.get(key) ?? []), change]);
    }
    for (const [target, changes] of otherIntents) {
      const itemId = await commitHash(new TextEncoder().encode(JSON.stringify([root.workspaceId, target, changes])));
      shadow.query("INSERT OR IGNORE INTO sync_recovery_items(id,kind,target,local,remote) VALUES(?,?,?,?,NULL)")
        .run(itemId, "entity", target, JSON.stringify({ title: "未提交的数据编辑", changes }));
    }
    for (const { id: docId } of candidates) {
      const local = getDocument(source, docId)!, remote = getDocument(shadow, docId);
      if (remote && local.body === remote.body && local.title === remote.title) continue;
      if (sourceTransport && local.title === remote?.title && restoreUncontestedText(source, shadow, docId, pending)) continue;
      const itemId = await commitHash(new TextEncoder().encode(JSON.stringify([root.workspaceId, docId, local.title, local.body])));
      shadow.query("INSERT OR IGNORE INTO sync_recovery_items(id,kind,target,local,remote) VALUES(?,?,?,?,?)")
        .run(itemId, "document", docId, JSON.stringify(local), remote ? JSON.stringify(remote) : null);
    }
    for (const table of ["replica_document_drafts", "replica_field_drafts"] as const) {
      if (!source.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      for (const draft of source.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
        const itemId = await commitHash(new TextEncoder().encode(JSON.stringify([root.workspaceId, table, draft])));
        shadow.query("INSERT OR IGNORE INTO sync_recovery_items(id,kind,target,local,remote) VALUES(?,?,?,?,NULL)")
          .run(itemId, table, String(draft.doc_id ?? draft.record_id), JSON.stringify(draft));
      }
    }
    if (oldGeneration && head.state.members[oldGeneration.incarnationId]) {
      shadow.query("INSERT OR REPLACE INTO meta(key,value) VALUES('sync_v2_retire',?)")
        .run(JSON.stringify({ member: oldGeneration.incarnationId, sequence: head.state.members[oldGeneration.incarnationId]!.sequence }));
    }

    if ((shadow.query("PRAGMA quick_check").get() as Record<string, string>)?.quick_check !== "ok")
      throw new MhError("invalid_input", "shadow database integrity check failed");
    // If a new epoch won during download, do not publish a stale replacement.
    const current = await log.read();
    if (current.state.epoch !== head.state.epoch) throw new MhError("busy", "checkpoint changed during recovery; original database retained");
    phase("swapping");
    await adapter.swap(shadow, id);
    committed = true;
    phase("pending");
    return { packageId: id, pending: recoveryItems(shadow).length };
  } finally {
    try {
      if (shadow) await adapter.releaseShadow(shadow, committed);
    } finally {
      await adapter.resume();
    }
  }
}

export async function loadV2DocumentHistory(db: DbDriver, client: StorageClient, config: S3Config, documentId: string) {
  const generation = readReplicaGeneration(db);
  if (!generation) throw new MhError("upgrade_required", "v2 history requires migration");
  const bucket = createV2Bucket(client, config);
  const metadata = db.query("SELECT value FROM meta WHERE key='sync_v2_checkpoint'").get() as { value: string } | null;
  const references = (metadata ? JSON.parse(metadata.value).history ?? [] : []) as { documentId: string; hash: string }[];
  const selected = references.filter(ref => ref.documentId === documentId);
  if (!selected.length) return; // new documents have only locally collected history
  for (const ref of selected) {
    if (db.query("SELECT 1 FROM meta WHERE key=?").get(`sync_v2_history_loaded:${ref.hash}`)) continue;
    let archive: unknown;
    try { archive = await bucket.load(ref.hash); }
    catch (error) { throw new MhError("history_unavailable", "历史尚未下载，请联网后重试"); }
    const parsed = DocumentArchiveSchema.parse(archive);
    if (parsed.documentId !== documentId) throw new MhError("invalid_input", "history document mismatch");
    writeTx(db, () => {
      installDocumentArchive(db, parsed, generation.workspaceId);
      db.query("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(`sync_v2_history_loaded:${ref.hash}`, "1");
    });
  }
}
