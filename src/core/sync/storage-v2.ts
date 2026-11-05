import { requireSupportedVersion, localDataVersion } from "./data-version.ts";
import { confirmPeerChanges, pendingPeerChanges } from "./peer-v2.ts";
import { observeHistory } from "./history-observation.ts";
import { withSyncBudget } from "./transport.ts";
import { ingestV2Batch } from "./v2-ingest.ts";
import type { DbDriver } from "../driver.ts";
import { writeTx } from "../driver.ts";
import { changesAfterSeq } from "../crdt.ts";
import { getNodeId } from "../node.ts";
import type { S3Config, StorageClient, StorageSyncOpts } from "./storage.ts";
import type { SyncResult } from "./client.ts";
import { createV2Bucket, BucketBatchSchema, type BucketBatch, type BucketRoot } from "./bucket-v2.ts";
import { readReplicaGeneration, writeReplicaGeneration, type ReplicaGeneration } from "./retention-protocol.ts";
import { MhError } from "../errors.ts";
import { DAY_MS, RETENTION_POLICY } from "./retention-state.ts";

function get<T>(db: DbDriver, key: string, fallback: T): T {
  const row = db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null;
  return row ? JSON.parse(row.value) : fallback;
}
function set(db: DbDriver, key: string, value: unknown) {
  db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
}
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("sync aborted");
}
interface Outbox { requestId: string; cursor: number; batch: BucketBatch; hash?: string }
export async function pullV2Log(db: DbDriver, bucket: ReturnType<typeof createV2Bucket>,
  root: BucketRoot, log: ReturnType<typeof bucket.log>,
  generation: ReplicaGeneration, opts: StorageSyncOpts = {}, through = Infinity) {
  const check = () => checkAbort(opts.signal);
  const key = `sync_v2_transport:${generation.incarnationId}`;
  const checkpointMeta = get(db, "sync_v2_checkpoint", { coveredSequence: 0 });
  let local = get(db, key, { applied: checkpointMeta.coveredSequence, cursor: 0, origin: 0 });
  let pulled = 0;
  // Validate and ingest all referenced objects before acknowledging their slot.
  // A missing middle object stops here; a later slot never proves its coverage.
  const head = await log.read(undefined, async (record, at, rejected) => {
    check();
    if (record.sequence <= local.applied) return;
    if (at.state.epoch !== generation.epoch || at.state.checkpoint !== generation.checkpoint)
      throw new MhError("rebootstrap_required", "checkpoint changed while downloading; preserve local edits before rebuilding");
    const event = record.payload;
    const batch = !rejected && event.type === "batch" ? await bucket.batchFor(root, event) : null;
    check();
    writeTx(db, () => {
      local = get(db, key, local);
      if (record.sequence <= local.applied) return;
      if (batch) {
        const result = ingestV2Batch(db, batch);
        if (result.poisoned || Object.values(result.skewed).some(n => n > 0)) throw new MhError("clock_skew", "v2 batch cannot be completely applied");
        observeHistory(db, batch.changes, at.serverTime!);
        confirmPeerChanges(db, batch.changes);
        pulled += result.received;
      }
      local = { ...local, applied: record.sequence };
      set(db, key, local);
    });
    if (batch) opts.onIngest?.();
  }, through);
  return { head, local, pulled };
}

/** One durable source stream per incarnation. SQLite seq is a local scan cursor
 * only; the wire stream carries its own consecutive origin sequence numbers. */
export async function syncWithStorageV2(db: DbDriver, client: StorageClient, config: S3Config, opts: StorageSyncOpts = {}): Promise<SyncResult> {
  const check = () => checkAbort(opts.signal);
  check();
  const transport = client;
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    check(); const value = await withSyncBudget(operation, undefined, opts.signal); check(); return value;
  };
  client = {
    list: (...args) => guarded(() => transport.list(...args)),
    get: (...args) => guarded(() => transport.get(...args)),
    put: (...args) => guarded(() => transport.put(...args)),
    del: (...args) => guarded(() => transport.del(...args)),
    ...(transport.getWithMetadata ? { getWithMetadata: (...args: Parameters<NonNullable<StorageClient["getWithMetadata"]>>) => guarded(() => transport.getWithMetadata!(...args)) } : {}),
    ...(transport.conditionalCreateCapability ? { conditionalCreateCapability: () => guarded(() => transport.conditionalCreateCapability!()) } : {}),
  };
  requireSupportedVersion(localDataVersion(db));
  const generation = readReplicaGeneration(db);
  if (!generation) throw new MhError("upgrade_required", "workspace migration is required");
  const bucket = createV2Bucket(client, config, db), root = await bucket.root();
  check();
  if (!root) throw new MhError("busy", "workspace root is temporarily unavailable");
  if (root.workspaceId !== generation.workspaceId) throw new MhError("rebootstrap_required", "workspace identity mismatch");
  const log = bucket.log(root);
  let head = await log.read();
  const observed = bucket.serverTime();
  if (observed !== null && head.serverTime !== null &&
      (observed - head.serverTime >= DAY_MS || (head.state.preparing && observed - head.state.preparing.startedAt >= RETENTION_POLICY.prepareMs))) {
    await log.append(crypto.randomUUID(), () => ({ type: "clock" }));
    head = await log.read();
  }
  check();
  if (head.state.epoch !== generation.epoch || head.state.checkpoint !== generation.checkpoint)
    throw new MhError("rebootstrap_required", "current checkpoint must be installed before upload");
  const key = `sync_v2_transport:${generation.incarnationId}`;
  const download = await pullV2Log(db, bucket, root, log, generation, opts);
  head = download.head;
  let local = download.local;
  const pulled = download.pulled;
  let pushed = 0;
  check();
  let member = head.state.members[generation.incarnationId];
  if (!member) {
    if (local.origin) throw new MhError("rebootstrap_required", "device instance has been retired");
    const replaces = get<{ member: string; sequence: number } | null>(db, "sync_v2_retire", null);
    await log.append(`join-${generation.incarnationId}`, () => ({ type: "join", epoch: generation.epoch, member: generation.incarnationId, checkpoint: generation.checkpoint, ...(replaces ? { replaces } : {}) }));
    head = await log.read();
    member = head.state.members[generation.incarnationId]!;
  }
  // Refresh server time through the same ordered log, never through device HLC.
  if (head.state.preparing && head.serverTime! - head.state.preparing.startedAt >= RETENTION_POLICY.prepareMs) {
    const preparing = head.state.preparing;
    await log.append(`cancel-${preparing.id}`, () => ({ type: "cancel", epoch: generation.epoch, id: preparing.id }));
    head = await log.read();
    member = head.state.members[generation.incarnationId]!;
  }
  if (head.serverTime !== null && member.expiresAt <= head.serverTime) {
    if (head.state.preparing) throw new MhError("busy", "membership registration waits for collection to commit or cancel");
    // Lease expiry alone does not require downloading a new database. The
    // checkpoint above is still current; rotate identity and preserve its queue.
    const incarnationId = crypto.randomUUID();
    writeTx(db, () => {
      writeReplicaGeneration(db, { ...generation, incarnationId });
      set(db, `sync_v2_transport:${incarnationId}`, { ...local, origin: 0 });
    });
    return syncWithStorageV2(db, client, config, opts);
  }
  if (member.sealed) {
    const { maintainV2Workspace } = await import("./v2-maintenance.ts");
    await maintainV2Workspace(db, client, config);
    return { pushed, pulled, pendingPush: true, warnings: ["正在更新本地副本；新编辑已在本地保存"] };
  }
  let outbox = get<Outbox | null>(db, `${key}:outbox`, null);
  if (!outbox) {
    const pending = changesAfterSeq(db, local.cursor, { onlyNode: getNodeId(db), limit: opts.pushLimit ?? 1000 });
    if (pending.changes.length) {
      outbox = { requestId: crypto.randomUUID(), cursor: pending.cursor,
        batch: { protocolVersion: 2, workspaceId: generation.workspaceId, epoch: generation.epoch, member: generation.incarnationId,
          first: local.origin + 1, last: local.origin + pending.changes.length, changes: pending.changes,
          bases: pending.changes.map(c => get<string | null>(db, `sync_v2_base:${c.hlc}:${c.dataset}:${c.row_id}:${c.col}`, null)) } };
      set(db, `${key}:outbox`, outbox);
    }
  }
  if (outbox) {
    BucketBatchSchema.parse(outbox.batch);
    if (!outbox.hash) {
      outbox.hash = await bucket.publish(outbox.batch);
      check(); set(db, `${key}:outbox`, outbox);
    }
    const pending = outbox;
    await log.append(pending.requestId, () => ({ type: "batch", epoch: generation.epoch, member: generation.incarnationId,
      first: pending.batch.first, last: pending.batch.last, objectHash: pending.hash! }));
    check();
    writeTx(db, () => {
      local = { ...local, cursor: pending.cursor, origin: pending.batch.last };
      set(db, key, local); set(db, `${key}:outbox`, null);
    });
    pushed = pending.batch.changes.length;
    head = await log.read();
  }
  const peerPending = pendingPeerChanges(db).length > 0;
  const pendingPush = peerPending || changesAfterSeq(db, local.cursor, { onlyNode: getNodeId(db), limit: 1 }).changes.length > 0;
  // Seal only after the complete local source prefix is committed. Edits made
  // after this durable record remain local and must wait for cancel/new epoch.
  if (head.state.preparing && !pendingPush) {
    const preparing = head.state.preparing;
    await log.append(`seal-${preparing.id}-${generation.incarnationId}`, () => ({ type: "seal", epoch: generation.epoch,
      id: preparing.id, member: generation.incarnationId, sequence: local.origin }));
  } else if (!head.state.preparing && head.serverTime! - member.renewedAt >= DAY_MS) {
    await log.append(`renew-${generation.incarnationId}-${Math.floor(head.serverTime! / DAY_MS)}`, () => ({ type: "renew", epoch: generation.epoch,
      member: generation.incarnationId, sequence: local.origin, checkpoint: generation.checkpoint }));
  }
  if (!pendingPush) {
    // Maintenance failures must not turn a committed upload into an apparent
    // failure; report them separately and leave all collection data untouched.
    try { const { maintainV2Workspace } = await import("./v2-maintenance.ts"); await maintainV2Workspace(db, client, config); }
    catch (error) { return { pushed, pulled, pendingPush, warnings: [error instanceof Error ? error.message : "回收预览暂不可用"] }; }
  }
  return { pushed, pulled, pendingPush, ...(peerPending ? { warnings: ["对等设备的编辑已保存在本地，等待来源设备提交到云端"] } : {}) };
}
