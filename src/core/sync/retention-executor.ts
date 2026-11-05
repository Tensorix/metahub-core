import { pendingPeerChanges } from "./peer-v2.ts";
import { historyChangeKey } from "./history-observation.ts";
import { commitHash } from "./commit-log.ts";
import type { DbDriver } from "../driver.ts";
import type { S3Config, StorageClient } from "./storage.ts";
import { createV2Bucket } from "./bucket-v2.ts";
import { captureCurrentCheckpoint } from "./current-checkpoint.ts";
import { readReplicaGeneration } from "./retention-protocol.ts";
import { splitDocumentArchive, captureDocumentArchive, DocumentArchiveSchema, installDocumentArchive, type DocumentArchive } from "../history-archive.ts";
import { DAY_MS, RETENTION_POLICY } from "./retention-state.ts";
import { MhError } from "../errors.ts";
import { getNodeId } from "../node.ts";
import { changesAfterSeq } from "../crdt.ts";
import type { Change } from "../crdt.ts";

export interface RetentionReport {
  workspaceId: string; checkpoint: string; epoch: number; observedAt: number; candidates: string[]; blockedBy: string[]; deletionTimes: Record<string, number>;
  eligible: boolean; reason: string | null; currentFields: number; projectedFields: number;
}
/** Keep each register's last value before the window, plus every collected
 * transition in the window. Baseline values do not imply continuous coverage. */
export function retainHistoryWindow(archive: DocumentArchive, cutoff: number): DocumentArchive {
  const baseline = new Map<string, Change>(), recent: Change[] = [];
  const observations = new Map(archive.changes.map((c,i) => [historyChangeKey(c), archive.observedAt?.[i] ?? null]));
  for (const change of archive.changes) {
    const time = observations.get(historyChangeKey(change));
    if (time == null || time >= cutoff) { recent.push(change); continue; }
    const key = JSON.stringify([change.dataset, change.row_id, change.col]);
    if (!baseline.has(key) || baseline.get(key)!.hlc < change.hlc) baseline.set(key, change);
  }
  const recentBlocks = new Set(recent.filter(c => c.dataset === "doc_blocks").map(c => c.row_id));
  const expired = new Set([...baseline.values()].filter(c => c.dataset === "doc_blocks" && c.col === "__deleted" && c.value === "1" && !recentBlocks.has(c.row_id)).map(c => c.row_id));
  const changes = [...baseline.values(), ...recent].filter(c => c.dataset !== "doc_blocks" || !expired.has(c.row_id)).sort((a, b) => a.hlc.localeCompare(b.hlc));
  return { ...archive, changes, observedAt: changes.map(c => observations.get(historyChangeKey(c)) ?? null) };
}
/** Read-only daily candidate report. Age starts at observed bucket commit time,
 * including migration tombstones whose original delete time is unprovable. */
export async function inspectRetention(db: DbDriver, client: StorageClient, config: S3Config): Promise<RetentionReport> {
  const generation = readReplicaGeneration(db);
  if (!generation) throw new MhError("upgrade_required", "retention requires v2");
  const bucket = createV2Bucket(client, config), root = await bucket.root();
  if (!root) throw new MhError("busy", "v2 root unavailable");
  const log = bucket.log(root), head = await log.read();
  const at = bucket.serverTime();
  if (at === null || bucket.rootCommittedAt() === null) throw new MhError("clock_skew", "bucket time unavailable");
  if (head.state.epoch !== generation.epoch || head.state.checkpoint !== generation.checkpoint)
    throw new MhError("rebootstrap_required", "retention requires current epoch");
  const observed = new Map<string, number>();
  // Carry forward certified deletion times; legacy checkpoints without a
  // timestamp conservatively begin observation at their committed baseline.
  const checkpoint = await bucket.checkpointFor(root, generation.checkpoint!, generation.epoch);
  const baselineTime = head.state.lastGcAt ?? bucket.rootCommittedAt()!;
  for (const block of checkpoint.deletedBlocks) observed.set(block.id, block.confirmedAt ?? baselineTime);
  await log.read(undefined, async (record, after, rejected) => {
    if (rejected || record.sequence <= checkpoint.coveredSequence || record.payload.type !== "batch") return;
    const batch = await bucket.batchFor(root, record.payload);
    for (const change of batch.changes) {
      if (change.dataset === "doc_blocks" && change.col === "__deleted" && change.value === "1" && !observed.has(change.row_id))
        observed.set(change.row_id, after.serverTime!);
    }
  });
  const liveDeleted = new Set((db.query("SELECT id FROM doc_blocks WHERE __deleted=1").all() as { id: string }[]).map(r => r.id));
  const candidates = [...observed].filter(([id, deletedAt]) => liveDeleted.has(id) && at - deletedAt >= RETENTION_POLICY.syncDays * DAY_MS).map(([id]) => id).sort();
  const current = captureCurrentCheckpoint(db, generation.workspaceId, generation.epoch);
  const deleted = new Set(candidates);
  const blockedBy = Object.entries(head.state.members).filter(([, m]) => m.expiresAt > at && !m.sealed).map(([id]) => id);
  const transport = db.query("SELECT value FROM meta WHERE key=?").get(`sync_v2_transport:${generation.incarnationId}`) as { value: string } | null;
  const applied = transport ? JSON.parse(transport.value).applied : checkpoint.coveredSequence;
  const reason = pendingPeerChanges(db).length ? "等待对等同步变更提交到存储桶" : !candidates.length ? "没有满 30 天的删除块" : applied < head.sequence ? "等待完整同步" :
    head.state.lastGcAt !== null && at - head.state.lastGcAt < RETENTION_POLICY.gcIntervalMs ? "距上次回收未满 7 天" : null;
  return { workspaceId: generation.workspaceId, checkpoint: generation.checkpoint!, epoch: generation.epoch, observedAt: at, candidates, blockedBy, deletionTimes: Object.fromEntries(observed), eligible: reason === null, reason,
    currentFields: current.changes.length, projectedFields: current.changes.filter(c => c.dataset !== "doc_blocks" || !deleted.has(c.row_id)).length };
}

/** Prepare/commit can be resumed by any complete node. Production must explicitly
 * enable this after its dry-run report is reviewed; no election grants authority. */
export async function executeRetention(db: DbDriver, client: StorageClient, config: S3Config, options: { enabled: boolean }) {
  const report = await inspectRetention(db, client, config);
  if (!options.enabled || !report.eligible) return { status: "dry_run" as const, report };
  const bucket = createV2Bucket(client, config), root = (await bucket.root())!, log = bucket.log(root);
  await log.append(crypto.randomUUID(), () => ({ type: "clock" }));
  let head = await log.read();
  if (!head.state.preparing) {
    const id = crypto.randomUUID();
    await log.append(`prepare-${id}`, state => ({ type: "prepare", epoch: state.epoch, id }));
    return { status: "waiting_for_seals" as const, report };
  }
  const preparing = head.state.preparing;
  if (head.serverTime! - preparing.startedAt >= RETENTION_POLICY.prepareMs) {
    await log.append(`cancel-${preparing.id}`, state => ({ type: "cancel", epoch: state.epoch, id: preparing.id }));
    return { status: "cancelled" as const, report };
  }
  if (!preparing.members.every(id => head.state.members[id]!.sealed)) return { status: "waiting_for_seals" as const, report };
  const generation = readReplicaGeneration(db)!;
  const transport = db.query("SELECT value FROM meta WHERE key=?").get(`sync_v2_transport:${generation.incarnationId}`) as { value: string } | null;
  if (!transport || changesAfterSeq(db, JSON.parse(transport.value).cursor, { onlyNode: getNodeId(db), limit: 1 }).changes.length)
    throw new MhError("busy", "post-seal local edits must remain queued; use another complete node for collection");
  // Archive previously collected history before moving content out of current
  // state. Any missing dependency aborts the commit and preserves old data.
  const previous = await bucket.checkpointFor(root, generation.checkpoint!, generation.epoch);
  for (const ref of previous.history) {
    const archive = DocumentArchiveSchema.parse(await bucket.load(ref.hash));
    if (archive.documentId !== ref.documentId) throw new MhError("invalid_input", "history identity mismatch");
    installDocumentArchive(db, archive, generation.workspaceId);
  }
  const checkpoint = captureCurrentCheckpoint(db, generation.workspaceId, generation.epoch + 1);
  checkpoint.coveredSequence = head.sequence;
  checkpoint.sourceCoverage = Object.fromEntries(Object.entries(head.state.members).map(([id, member]) => [id, member.sequence]));
  for (const row of db.query("SELECT id FROM documents ORDER BY id").all() as { id: string }[]) {
    const collected = captureDocumentArchive(db, generation.workspaceId, row.id);
    collected.observedAt = collected.changes.map((_, i) => collected.observedAt?.[i] ?? head.serverTime!);
    const archive = retainHistoryWindow(collected, head.serverTime! - RETENTION_POLICY.historyDays * DAY_MS);
    for (const part of splitDocumentArchive(archive)) checkpoint.history.push({ documentId: row.id, hash: await bucket.publish(part) });
  }
  const candidates = new Set(report.candidates);
  checkpoint.changes = checkpoint.changes.filter(c => c.dataset !== "doc_blocks" || !candidates.has(c.row_id));
  checkpoint.deletedBlocks = checkpoint.deletedBlocks.filter(c => !candidates.has(c.id)).map(c => ({ ...c, confirmedAt: report.deletionTimes[c.id] ?? report.observedAt }));
  const digest = await bucket.publish(checkpoint);
  // Conditional slot arbitration revalidates the barrier and deadline. A slow
  // archive upload cannot commit after a concurrent cancellation.
  await log.append(`commit-${preparing.id}`, state => ({ type: "commit", epoch: state.epoch, id: preparing.id, checkpoint: digest }));
  head = await log.read();
  return { status: "committed" as const, report, checkpoint: digest, protectedUntil: head.state.protectedUntil };
}

/** Delete only objects covered by an accepted checkpoint after its protection
 * window. Control slots and unreferenced uploads are deliberately never swept. */
export async function cleanRetiredV2Objects(client: StorageClient, config: S3Config, options: { enabled: boolean }) {
  const bucket = createV2Bucket(client, config), root = await bucket.root();
  if (!root) return { deleted: 0, candidates: 0 };
  const log = bucket.log(root), head = await log.read(), now = bucket.serverTime();
  if (!head.state.protectedUntil || now === null || now < head.state.protectedUntil)
    return { deleted: 0, candidates: 0 };
  const current = await bucket.checkpointFor(root, head.state.checkpoint!, head.state.epoch);
  // Verify every retained history object before making any deletion request.
  for (const reference of current.history) {
    const archive = DocumentArchiveSchema.parse(await bucket.load(reference.hash));
    if (archive.documentId !== reference.documentId || archive.workspaceId !== root.workspaceId)
      throw new MhError("invalid_input", "retained history dependency mismatch");
  }
  const retained = new Set([head.state.checkpoint!, ...current.history.map(ref => ref.hash)]);
  const retired = new Set<string>();
  await log.read(undefined, async (record, _, rejected) => {
    if (rejected || record.sequence > current.coveredSequence) return;
    if (record.payload.type === "batch") {
      // First-release collection is scoped to document blocks. Mixed batches
      // may contain record/database history that has no archival proof yet.
      const bytes = await client.get(bucket.objectKey(record.payload.objectHash), { maxBytes: 64 * 1024 * 1024 });
      if (bytes) {
        const batch = await bucket.batchFor(root, record.payload);
        if (batch.changes.every(c => c.dataset === "doc_blocks")) retired.add(record.payload.objectHash);
      }
    }
    if (record.payload.type === "commit" && record.payload.checkpoint !== head.state.checkpoint) retired.add(record.payload.checkpoint);
  });
  if (root.checkpoint !== head.state.checkpoint) retired.add(root.checkpoint);
  // Prior history indices may have already been removed by an interrupted sweep.
  // Read what remains; a missing index is not permission to infer/delete others.
  for (const digest of [...retired]) {
    const object = await client.get(bucket.objectKey(digest), { maxBytes: 64 * 1024 * 1024 });
    if (!object) continue;
    if (await commitHash(object) !== digest) throw new MhError("invalid_input", "retired object integrity check failed");
    const parsed = await bucket.codec.decode(object) as { format?: string; history?: { hash: string }[] };
    if (parsed.format === "metahub-current") for (const reference of parsed.history ?? []) retired.add(reference.hash);
  }
  const candidates = [...retired].filter(digest => !retained.has(digest));
  if (!options.enabled) return { deleted: 0, candidates: candidates.length };
  // A later epoch can appear while checking references. It extends protection;
  // stop rather than use an earlier deadline to authorize its cleanup.
  const checked = await log.read();
  if (checked.state.epoch !== head.state.epoch) throw new MhError("busy", "retention generation changed during cleanup");
  let deleted = 0;
  for (const digest of candidates) { await client.del(bucket.objectKey(digest)); deleted++; }
  return { deleted, candidates: candidates.length };
}
