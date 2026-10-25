import type { DbDriver } from "../driver.ts";
import { errorCode } from "../errors.ts";
import { getNodeId } from "../node.ts";
import { syncWithPeer, type SyncOpts, type SyncResult } from "../sync/client.ts";
import { storageClientFor, syncWithStorage, type S3Config } from "../sync/storage.ts";
import { storageUrl } from "../sync/storage-url.ts";
import { withSyncBudget } from "../sync/transport.ts";
import { replicaChangesSince, replicaSequence, type ReplicaChange } from "./service.ts";

export type ReplicaSyncTarget =
  | { kind: "http"; url: string; token?: string; fetch?: SyncOpts["fetch"] }
  | { kind: "s3"; config: S3Config };
export interface ReplicaSyncStatus {
  syncing: boolean;
  connected: boolean;
  authInvalid: boolean;
  hydrationReady: boolean;
  /** Number of local changes still unacknowledged by at least one target. */
  pendingPush: number;
  /** A target has not yet returned an exhausted pull page. */
  pendingPull: boolean;
  phase: "idle" | "syncing" | "hydrating" | "offline" | "error";
  lastSyncAt: number | null;
  lastSuccessAt: number | null;
  error: string | null;
  pushed: number;
  pulled: number;
  warnings: string[];
}
export interface ReplicaSyncOptions {
  /** Secrets are resolved by the owner; never copied into SQLite. */
  targets: () => readonly ReplicaSyncTarget[];
  onChange?: (change: ReplicaChange) => void;
  onStatus?: (status: ReplicaSyncStatus) => void;
  intervalMs?: number;
  debounceMs?: number;
  batchSize?: number;
  /** Bound each turn so a large hydration yields to other targets and UI work. */
  pagesPerRound?: number;
  syncTarget?: (target: ReplicaSyncTarget, signal: AbortSignal) => Promise<SyncResult>;
}
const targetUrl = (target: ReplicaSyncTarget) => target.kind === "http" ? target.url : storageUrl(target.config.endpoint, target.config.bucket, target.config.prefix);
const yieldTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** One coalescing scheduler per workspace; local reads and commands remain
 * available between bounded ingestion pages, even while transports are offline. */
export function createReplicaSync(db: DbDriver, options: ReplicaSyncOptions) {
  const batchSize = options.batchSize ?? 200;
  const pagesPerRound = options.pagesPerRound ?? 4;
  for (const value of [batchSize, pagesPerRound])
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("sync batch sizes must be positive integers");
  db.exec("CREATE TABLE IF NOT EXISTS replica_sync_state (target TEXT PRIMARY KEY, hydrated INTEGER NOT NULL DEFAULT 0)");
  const hydrated = (target: ReplicaSyncTarget) => !!(db.query("SELECT hydrated FROM replica_sync_state WHERE target = ?").get(targetUrl(target)) as { hydrated: number } | null)?.hydrated;
  const isReady = () => { const targets = options.targets(); return targets.every(hydrated); };
  const countPending = () => {
    const predicates: string[] = [];
    const params: (string | number)[] = [];
    for (const target of options.targets()) {
      const cursor = (db.query("SELECT push_cursor FROM peers WHERE url = ?").get(targetUrl(target)) as { push_cursor: number } | null)?.push_cursor ?? 0;
      predicates.push(target.kind === "http" ? "seq > ?" : "(seq > ? AND node_id = ?)");
      params.push(cursor);
      if (target.kind === "s3") params.push(getNodeId(db));
    }
    if (!predicates.length) return 0;
    return (db.query(`SELECT count(*) AS n FROM crdt_changes WHERE ${predicates.join(" OR ")}`).get(...params) as { n: number }).n;
  };
  const unexhausted = new Set(options.targets().filter(target => !hydrated(target)).map(targetUrl));
  const hasPendingPull = () => options.targets().some(target => unexhausted.has(targetUrl(target)) || !hydrated(target));
  let status: ReplicaSyncStatus = {
    syncing: false, connected: false, authInvalid: false, hydrationReady: isReady(), pendingPush: countPending(),
    pendingPull: hasPendingPull(), phase: "idle", lastSyncAt: null, lastSuccessAt: null,
    error: null, pushed: 0, pulled: 0, warnings: [],
  };
  const listeners = new Set<(status: ReplicaSyncStatus) => void>();
  if (options.onStatus) listeners.add(options.onStatus);
  let running: Promise<void> | null = null;
  let started = false;
  let active = true;
  let pending = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;
  const update = (patch: Partial<ReplicaSyncStatus>) => {
    status = { ...status, ...patch };
    for (const listener of listeners) listener(status);
  };
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const schedule = (delay: number) => {
    clearTimer();
    if (!started || !active) return;
    timer = setTimeout(() => { timer = null; void syncNow(); }, delay);
  };
  const perform = async (target: ReplicaSyncTarget, signal: AbortSignal, onIngest: () => void): Promise<SyncResult> => {
    const url = targetUrl(target);
    // Only transport identity and cursors are durable. Keys and credentials stay
    // in SecureStore and the current session's target resolver.
    db.query("INSERT INTO peers (url, kind, enabled) VALUES (?, ?, 1) ON CONFLICT(url) DO UPDATE SET kind=excluded.kind, config=NULL, token=NULL, enabled=1")
      .run(url, target.kind);
    if (options.syncTarget) return withSyncBudget(() => options.syncTarget!(target, signal), undefined, signal);
    if (target.kind === "http") return syncWithPeer(db, url, {
      token: target.token, fetch: target.fetch, signal, pullLimit: batchSize, pushLimit: batchSize,
    });
    return syncWithStorage(db, url, storageClientFor(target.config, { signal }), target.config, {
      forcePush: true, publish: target.config.publish ?? false, priority: target.config.priority,
      pushLimit: batchSize, ingestBatchSize: batchSize, pullObjectLimit: 1, signal, onIngest,
    });
  };
  async function round(): Promise<void> {
    abort = new AbortController();
    const signal = abort.signal;
    let pushed = 0;
    let pulled = 0;
    const warnings: string[] = [];
    const errors: string[] = [];
    let successes = 0;
    let authInvalid = false;
    const targets = options.targets();
    update({ syncing: targets.length > 0, error: null, phase: isReady() ? "syncing" : "hydrating", pendingPush: countPending() });
    for (const target of targets) {
      if (signal.aborted) break;
      try {
        for (let page = 0; page < pagesPerRound && !signal.aborted; page++) {
          let before = replicaSequence(db);
          const notify = () => {
            const change = replicaChangesSince(db, before);
            before = replicaSequence(db);
            if (change) options.onChange?.(change);
          };
          let result: SyncResult;
          try { result = await perform(target, signal, notify); }
          finally { notify(); }
          if (signal.aborted) break;
          pushed += result.pushed;
          pulled += result.pulled;
          warnings.push(...(result.warnings ?? []));
          const pullRemaining = result.pendingPull ?? (target.kind === "http" && (result.received ?? 0) >= batchSize);
          if (pullRemaining) unexhausted.add(targetUrl(target));
          else unexhausted.delete(targetUrl(target));
          if (!pullRemaining) db.query("INSERT INTO replica_sync_state (target, hydrated) VALUES (?, 1) ON CONFLICT(target) DO UPDATE SET hydrated=1").run(targetUrl(target));
          const ready = isReady();
          update({ pushed, pulled, hydrationReady: ready, pendingPush: countPending(), pendingPull: hasPendingPull() });
          if (!result.pendingPush && !pullRemaining) { break; }
          if (page === pagesPerRound - 1) pending = true;
          await yieldTurn();
        }
        if (!signal.aborted) successes++;
      } catch (error) {
        if (!signal.aborted) {
          authInvalid ||= errorCode(error) === "auth";
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    const now = Date.now();
    if (!signal.aborted) {
      failures = errors.length ? failures + 1 : 0;
      const ready = isReady();
      update({ syncing: false, connected: successes > 0, authInvalid, hydrationReady: ready,
        pendingPush: countPending(), pendingPull: hasPendingPull(),
        phase: errors.length ? "error" : !ready ? "hydrating" : "idle", lastSyncAt: now,
        lastSuccessAt: successes > 0 ? now : status.lastSuccessAt,
        pushed, pulled, warnings, error: errors.length ? errors.join("\n") : null });
    } else update({ syncing: false, phase: "offline" });
    abort = null;
  }
  function syncNow(): Promise<void> {
    if (running) { pending = true; return running; }
    if (!active) return Promise.resolve();
    clearTimer();
    pending = false;
    running = round().catch(error => {
      failures++;
      update({ syncing: false, connected: false, phase: "error", error: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      running = null;
      const retryDelay = Math.min(120_000, (options.intervalMs ?? 15_000) * 2 ** Math.min(failures, 3));
      schedule(pending && !failures ? (options.debounceMs ?? 600) : retryDelay);
    });
    return running;
  }
  return {
    get status() { return status; },
    onStatus(listener: (status: ReplicaSyncStatus) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start() { if (started) return; started = true; active = true; schedule(0); },
    async stop() {
      started = false; active = false; clearTimer(); abort?.abort();
      await running;
      update({ syncing: false, connected: false, phase: "offline" });
    },
    setActive(value: boolean) {
      active = value;
      if (!active) { clearTimer(); abort?.abort(); update({ connected: false, phase: "offline" }); }
      else if (started) schedule(0);
    },
    requestSync() { pending = true; update({ pendingPush: countPending() }); if (!running) schedule(options.debounceMs ?? 600); },
    syncNow,
  };
}
export type ReplicaSync = ReturnType<typeof createReplicaSync>;
