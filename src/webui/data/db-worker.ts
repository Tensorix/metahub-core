// The browser replica: a dedicated worker hosting the full metahub core on an
// OPFS SQLite database (sqlite-wasm, opfs-sahpool VFS — synchronous inside a
// dedicated worker, no COOP/COEP). The WebUI's local-api facade talks to it
// over a tiny RPC; replication reuses the exact same /sync protocol and
// syncWithPeer() client the CLI and desktop nodes use — the browser is just
// another node.
//
// Lifecycle: boots and opens the DB immediately; RPC calls queue behind the
// init promise. Pairing ("pair" op, one-time) stores the server-issued grant
// in the local peers table; from then on the periodic sync loop runs whenever
// the tab is alive and online. Status transitions and post-pull invalidation
// hints are broadcast as events.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { WasmDriver, type Oo1Db } from "./wasm-driver.ts";
import type { DbDriver } from "../../core/driver.ts";
import { initSchema } from "../../core/schema-init.ts";
import { getNodeId } from "../../core/node.ts";
import { randomSuffix } from "../../core/ids.ts";
import { MhError, errorCode } from "../../core/errors.ts";
import { changesAfterSeq } from "../../core/crdt.ts";
import { referencedHashes } from "../../core/blobs-core.ts";
import { syncWithPeer } from "../../core/sync/client.ts";
import {
  addPeer,
  getPeer,
  removePeer,
  listPeers,
  addStoragePeer,
  syncPeer,
} from "../../core/sync/peers.ts";
import { storageUrl } from "../../core/sync/storage-url.ts";
import {
  provisionMasterKey,
  storageClientFor,
  getBucketBlob,
  putBucketBlob,
  type S3Config,
} from "../../core/sync/storage.ts";
import "./storage-s3-browser.ts"; // side effect: register the browser SigV4 S3 client
import {
  spoolGet,
  spoolPending,
  spoolDelete,
  cachePut,
  verifyBytes,
} from "./blob-store.ts";
import { PAIR_PATH, type PairRequest, type PairResponse } from "../../core/sync/protocol.ts";
import {
  listDatabases,
  createDatabase,
  updateDatabase,
  duplicateDatabase,
  deleteDatabase,
} from "../../core/databases.ts";
import {
  listProperties,
  addProperty,
  updateProperty,
  setPropertyWidth,
  removeProperty,
  type PropType,
  type PropertyConfig,
} from "../../core/properties.ts";
import {
  listRecords,
  getRecord,
  createRecord,
  updateRecord,
  moveRecord,
  deleteRecord,
} from "../../core/records.ts";
import {
  listDocuments,
  getDocument,
  createDocument,
  updateDocument,
  documentVersion,
  moveDocument,
  duplicateDocument,
  deleteDocument,
} from "../../core/documents.ts";
import {
  listDocumentRevisions,
  documentAtVersion,
  revertDocument,
  listRecordRevisions,
  recordAtVersion,
  recordFieldHistory,
  revertRecord,
  listPropertyRevisions,
  revertProperty,
  listDatabaseActivity,
} from "../../core/history.ts";
import { search } from "../../core/search.ts";
import {
  resolveSite,
  getFileRow,
  listSites,
  listFiles,
  createSite,
  updateSite,
  deleteSite,
  deleteFile,
  putFileInline,
  fileCount,
  type FileEncoding,
} from "../../core/sites-core.ts";

// ---- protocol ----------------------------------------------------------------

export interface RpcRequest {
  id: number;
  op: string;
  args: unknown[];
}
export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string; code?: string } };

export interface ReplicaStatus {
  state: "booting" | "hydrating" | "ready" | "error";
  paired: boolean;
  node: string | null;
  /** Total changes pulled so far during an in-progress hydration. */
  hydrated?: number;
  lastSync?: { at: number; ok: boolean; pushed: number; pulled: number; error?: string };
  /** This browser has local own ops not yet pushed to a directly attached bucket. */
  bucketDirty?: boolean;
  /** A direct bucket push/pull is currently running. */
  bucketSyncing?: boolean;
  /** Last direct bucket sync error, if the dirty changes could not be saved. */
  bucketError?: string;
  error?: string;
}
export type WorkerEvent =
  | { event: "status"; status: ReplicaStatus }
  | { event: "synced"; datasets: string[]; rowIds: string[]; pushed: number; pulled: number };

const SYNC_INTERVAL_MS = 15_000;
/** Changes per hydration pull. Bounds memory and yields progress events. */
const PULL_LIMIT = 2000;

// ---- state ---------------------------------------------------------------------

const origin = self.location.origin;
let db: DbDriver | null = null;
let status: ReplicaStatus = { state: "booting", paired: false, node: null };

function post(msg: RpcResponse | WorkerEvent): void {
  (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);
}

function setStatus(patch: Partial<ReplicaStatus>): void {
  status = { ...status, ...patch };
  post({ event: "status", status });
}

/** The live driver, or a clean retryable error if the db isn't open yet — e.g.
 *  an op arriving during the brief window inside `reset` (wipe → re-open) or
 *  before boot finished. Beats a raw `db!` null-deref. */
function requireDb(): DbDriver {
  if (!db) throw new MhError("network", "本地副本未就绪");
  return db;
}

// ---- boot ----------------------------------------------------------------------

type SahPool = {
  OpfsSAHPoolDb: new (path: string) => unknown;
  wipeFiles(): Promise<unknown>;
};
let pool: SahPool | null = null;
let oo1Db: { close(): void } | null = null;

/** (Re)open the OPFS database and (re)install the schema, pointing `db` at a
 *  fresh driver. `pool` must already be installed. Used at boot and again after
 *  a `reset` wipes the files, so the worker is never left with a null `db`
 *  (a paired op landing on a still-alive, just-reset worker would otherwise
 *  deref null — "Cannot read properties of null (reading 'query')"). */
function openDb(): void {
  const oo1 = new pool!.OpfsSAHPoolDb("/metahub.db") as unknown as Oo1Db & { close(): void };
  oo1Db = oo1;
  const driver = new WasmDriver(oo1);
  initSchema(driver);
  db = driver;
}

const ready: Promise<void> = (async () => {
  // No init options: the emscripten glue resolves sqlite3.wasm relative to
  // import.meta.url, which for the bundled worker (/db-worker.js) is exactly
  // the /sqlite3.wasm the server provides.
  const sqlite3 = await sqlite3InitModule();
  pool = (await sqlite3.installOpfsSAHPoolVfs({ name: "metahub-replica" })) as unknown as SahPool;
  openDb();
  const driver = db!;
  const node = getNodeId(driver);
  const paired = getPeer(driver, origin)?.token != null;
  const bucketDirty = hasPendingBucketPush(driver);
  if (bucketDirty) scheduleBucketFlush();
  setStatus({ state: "ready", node, paired, bucketDirty });
})().catch((e) => {
  setStatus({ state: "error", error: e instanceof Error ? e.message : String(e) });
  throw e;
});

// ---- sync loop -----------------------------------------------------------------

interface SyncOutcome {
  pushed: number;
  pulled: number;
  ok: boolean;
}
let syncing: Promise<SyncOutcome> | null = null;

/** Storage peers that have done at least one *full* (pull) round this session.
 *  First round per peer is always full — initial hydration, first snapshot, and
 *  the credentials/CORS check all need PULL; afterwards an origin-reachable round
 *  goes push-only. */
const bucketInitialSynced = new Set<string>();

/** One logical sync: loops pull rounds while the server still has more than
 *  PULL_LIMIT changes for us (initial hydration), then settles. Broadcasts a
 *  `synced` event listing what the pulls touched, derived from the local oplog
 *  (everything ingested lands above the pre-sync high-water rowid). */
/** True when there's anything to sync to: the paired origin server, or any
 *  enabled storage (s3) peer. Storage peers let the browser sync even when the
 *  origin server is offline/unreachable. */
function hasSyncTarget(d: DbDriver): boolean {
  if (getPeer(d, origin)?.token != null) return true;
  return listPeers(d).some((p) => p.enabled === 1 && p.kind === "s3");
}

function enabledStoragePeers(d: DbDriver) {
  return listPeers(d).filter((p) => p.enabled === 1 && p.kind === "s3");
}

function hasPendingBucketPush(d: DbDriver): boolean {
  const node = getNodeId(d);
  return enabledStoragePeers(d).some(
    (p) => changesAfterSeq(d, p.push_cursor, { onlyNode: node }).changes.length > 0,
  );
}

/** Push-batching for storage peers: coalesce edits into ~one segment per
 *  STORAGE_PUSH_AGE_MS (or per STORAGE_PUSH_MIN_CHANGES) instead of a tiny
 *  object per debounce, which costs a billed request + a GET for every puller.
 *  `force` (explicit "sync now") bypasses the thresholds so edits never strand. */
const STORAGE_PUSH_MIN_CHANGES = 25;
const STORAGE_PUSH_AGE_MS = 10_000;
let bucketFlushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleBucketFlush(): void {
  if (bucketFlushTimer) return;
  bucketFlushTimer = setTimeout(() => {
    bucketFlushTimer = null;
    if (navigator.onLine !== false) void runSync(true);
  }, STORAGE_PUSH_AGE_MS);
}

function clearBucketFlush(): void {
  if (!bucketFlushTimer) return;
  clearTimeout(bucketFlushTimer);
  bucketFlushTimer = null;
}

function markBucketDirty(): void {
  const d = db;
  if (!d) return;
  const bucketDirty = enabledStoragePeers(d).length > 0 && hasPendingBucketPush(d);
  setStatus({ bucketDirty, bucketError: undefined });
  if (bucketDirty) scheduleBucketFlush();
  else clearBucketFlush();
}

function restorePeerRow(d: DbDriver, row: NonNullable<ReturnType<typeof getPeer>>): void {
  d.query(
    `UPDATE peers SET
       pull_cursor = ?,
       push_cursor = ?,
       token = ?,
       label = ?,
       node_id = ?,
       enabled = ?,
       last_sync_at = ?,
       last_success_at = ?,
       last_status = ?,
       last_error = ?,
       kind = ?,
       config = ?
     WHERE url = ?`,
  ).run(
    row.pull_cursor,
    row.push_cursor,
    row.token,
    row.label,
    row.node_id,
    row.enabled,
    row.last_sync_at,
    row.last_success_at,
    row.last_status,
    row.last_error,
    row.kind,
    row.config,
    row.url,
  );
}

/**
 * Drain offline-composed blob bytes (spool) to attached buckets. Used by a
 * no-origin (bucket-only) replica, which has no server to POST /api/blob to — an
 * origin-backed replica drains via the page instead (api.ts drainBlobSpool, which
 * holds the master token). On a successful upload the bytes move to the evictable
 * byte cache and leave the spool, so pending storage stays bounded.
 */
async function drainSpoolToBuckets(d: DbDriver): Promise<void> {
  const buckets = enabledStoragePeers(d);
  if (!buckets.length) return;
  let pending: Awaited<ReturnType<typeof spoolPending>>;
  try {
    pending = await spoolPending();
  } catch {
    return;
  }
  for (const e of pending) {
    let durable = false;
    for (const peer of buckets) {
      if (!peer.config) continue;
      try {
        await putBucketBlob(JSON.parse(peer.config) as S3Config, e.hash, new Uint8Array(e.bytes));
        durable = true;
        break;
      } catch {
        // bucket unreachable — keep it spooled, retry next round
      }
    }
    if (durable) {
      await cachePut(e.hash, e.bytes, e.content_type).catch(() => {});
      await spoolDelete(e.hash).catch(() => {});
    }
  }
}

async function runSync(force = false): Promise<SyncOutcome> {
  if (!db) return { pushed: 0, pulled: 0, ok: true };
  const d = db;
  if (!hasSyncTarget(d)) return { pushed: 0, pulled: 0, ok: true };
  if (syncing) return syncing;
  syncing = (async (): Promise<SyncOutcome> => {
    const before = (
      d.query("SELECT MAX(rowid) AS m FROM crdt_changes").get() as { m: number | null }
    ).m ?? 0;

    let pushed = 0;
    let pulled = 0;
    const errors: string[] = [];
    const bucketErrors: string[] = [];
    const hasBuckets = enabledStoragePeers(d).length > 0;
    // Only surface "saving" for rounds that actually flush the bucket. Every
    // user-meaningful bucket write is a forced round (the 10s coalesce timer,
    // explicit save / ⌘S, first sync); the non-forced debounce/poll rounds skip
    // the push under STORAGE_PUSH thresholds (see storage.ts) and uploaded
    // nothing — flagging them made the button flicker "保存中…" while just typing.
    if (hasBuckets && force) setStatus({ bucketSyncing: true, bucketError: undefined });

    // Origin server (http), chunked initial hydration — only if paired. Its
    // failure (server offline) must not stop storage-peer sync below. Whether it
    // succeeded decides push-only vs full bucket rounds below: a reachable origin
    // already delivers a superset of the bucket, so storage peers go push-only
    // (Path B durability without the LIST-heavy PULL); origin down → full bucket
    // round as the fallback transport.
    let originOk = false;
    if (getPeer(d, origin)?.token != null) {
      try {
        let received = 0;
        for (;;) {
          const cursorBefore = getPeer(d, origin)?.pull_cursor ?? 0;
          const r = await syncWithPeer(d, origin, { pullLimit: PULL_LIMIT });
          pushed += r.pushed;
          pulled += r.pulled;
          received += r.received ?? r.pulled;
          // Break on the response page size, not the newly-ingested count: a page
          // of all-known changes ingests 0 but isn't necessarily the last page
          // (e.g. after a seq-migration cursor reset re-pulls data we already hold).
          if ((r.received ?? r.pulled) < PULL_LIMIT) break;
          // Self-protection: a well-behaved server advances the cursor every full
          // page (monotonic seq). If it returned a full page WITHOUT advancing
          // (buggy/old server), stop instead of re-pulling the same page forever.
          if ((getPeer(d, origin)?.pull_cursor ?? 0) === cursorBefore) break;
          // Progress reflects rows actually received (not just newly-ingested), so
          // a re-pulled-but-known catch-up doesn't appear frozen at 0.
          setStatus({ state: "hydrating", hydrated: received });
        }
        originOk = true;
      } catch (e) {
        errors.push(`server: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Storage (s3) peers — each captures its own error into last_status. A round
    // is push-only when the origin is reachable AND this isn't a forced sync AND
    // the peer already did one full round this session; otherwise full (initial
    // hydration / first snapshot / cred+CORS check all need PULL).
    for (const peer of enabledStoragePeers(d)) {
      const pushOnly = originOk && !force && bucketInitialSynced.has(peer.url);
      const out = await syncPeer(d, peer.url, {
        storage: {
          minPushChanges: STORAGE_PUSH_MIN_CHANGES,
          maxPushAgeMs: STORAGE_PUSH_AGE_MS,
          forcePush: force,
          pull: !pushOnly,
        },
      });
      if (out.ok) {
        pushed += out.pushed ?? 0;
        pulled += out.pulled ?? 0;
        if (!pushOnly) bucketInitialSynced.add(peer.url); // a full round happened
      } else {
        const msg = `${peer.label ?? peer.url}: ${out.error}`;
        errors.push(msg);
        bucketErrors.push(msg);
      }
    }

    // When this round's origin push didn't happen — no origin configured, OR an
    // origin is configured but was unreachable — drain offline-composed blob bytes
    // to the bucket so other devices that pulled the doc from the bucket can fetch
    // them. (A reachable origin drains spool to its server from the page instead,
    // so gating on `originOk` rather than "origin unconfigured" also covers the
    // configured-but-offline case where doc changes still reached the bucket.)
    if (!originOk && hasBuckets) await drainSpoolToBuckets(d);

    const bucketDirty = hasBuckets ? hasPendingBucketPush(d) : false;
    if (bucketDirty && bucketErrors.length === 0) scheduleBucketFlush();
    else clearBucketFlush();
    const touched = d
      .query("SELECT DISTINCT dataset, row_id FROM crdt_changes WHERE rowid > ?")
      .all(before) as { dataset: string; row_id: string }[];
    setStatus({
      state: "ready",
      hydrated: undefined,
      lastSync: {
        at: Date.now(),
        ok: errors.length === 0,
        pushed,
        pulled,
        error: errors.join("; ") || undefined,
      },
      bucketDirty,
      bucketSyncing: false,
      bucketError: bucketErrors.join("; ") || undefined,
    });
    if (touched.length || pushed) {
      post({
        event: "synced",
        datasets: [...new Set(touched.map((t) => t.dataset))],
        rowIds: touched.map((t) => t.row_id),
        pushed,
        pulled,
      });
    }
    return { pushed, pulled, ok: errors.length === 0 };
  })().finally(() => {
    if (db && enabledStoragePeers(db).length > 0 && !status.bucketSyncing) {
      const bucketDirty = hasPendingBucketPush(db);
      if (bucketDirty && !status.bucketError) scheduleBucketFlush();
      else clearBucketFlush();
    }
    syncing = null;
  });
  return syncing;
}

// Background poll. A reactive, origin-backed replica does NOT poll in the
// background — it syncs on events (writes → schedulePush; online/visibility/
// refresh → the page's `sync` RPC) and revalidates the UI from the `synced`
// event. Only a no-origin PWA (the bucket-only data home / publisher, with no
// origin to track) must poll the bucket to receive other devices' edits; it backs
// off when idle, capped well under the publisher-lease TTL so failover stays
// timely.
const POLL_MAX_MS = 150_000; // 2.5min ≈ publisher-lease TTL/2
let pollDelay = SYNC_INTERVAL_MS;
/** ②b: a served site page is non-reactive (no revalidate once rendered), so the
 *  siteFile op re-pulls before serving when the local replica is older than this. */
const SITE_FRESH_MAX_AGE_MS = 3 * 60_000;

/** True only for a no-origin, bucket-only home: no reachable origin to track but
 *  enabled storage peers to receive from. An origin-backed replica returns false
 *  (event-driven, no background poll). */
function mustBackgroundPoll(): boolean {
  if (!db) return false;
  if (getPeer(db, origin)?.token != null) return false; // origin-backed → event-driven
  return listPeers(db).some((p) => p.enabled === 1 && p.kind === "s3");
}

async function pollTick(): Promise<void> {
  try {
    if (navigator.onLine !== false && mustBackgroundPoll()) {
      const out = await runSync();
      pollDelay =
        out.pushed > 0 || out.pulled > 0
          ? SYNC_INTERVAL_MS // real activity → keep polling promptly
          : Math.min(pollDelay * 2, POLL_MAX_MS); // idle (or a down bucket) → back off
    } else {
      pollDelay = SYNC_INTERVAL_MS; // reset so a later role change polls promptly
    }
  } finally {
    setTimeout(pollTick, pollDelay);
  }
}
setTimeout(pollTick, pollDelay);

// ---- pairing -------------------------------------------------------------------

/** Self-service pairing: the page (already holding the master token) minted a
 *  one-time code via POST /api/pair/new and hands it here; we redeem it for a
 *  durable, individually-revocable grant and store it as our peer credential.
 *  No self_url: the server must not register an unreachable browser as an
 *  outbound peer. (pairing.ts's performPairing isn't reused — it reads
 *  process.env at module load, which a browser bundle can't.) */
async function pair(code: string): Promise<{ node_id: string }> {
  const d = requireDb();
  const body: PairRequest = {
    code,
    node_id: getNodeId(d),
    // Protocol requires a grant for the mutual case; without self_url the
    // server discards it.
    grant: randomSuffix(32),
  };
  const res = await fetch(new URL(PAIR_PATH, origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new MhError(
      res.status === 401 || res.status === 403 ? "auth" : "network",
      `pairing failed: ${res.status} ${await res.text()}`,
    );
  }
  const data = (await res.json()) as PairResponse;
  addPeer(d, { url: origin, token: data.grant, node_id: data.node_id, label: "server" });
  setStatus({ paired: true });
  void runSync();
  return { node_id: data.node_id };
}

function unpair(): { ok: boolean } {
  const ok = removePeer(requireDb(), origin);
  setStatus({ paired: false });
  return { ok };
}

// ---- ops -----------------------------------------------------------------------

type Op = (...args: any[]) => unknown;

/** Mirrors the /api/* route semantics in src/webui/server/routes.ts (including
 *  not_found errors and document version tokens) so the local-api facade is a
 *  drop-in for the HTTP client. */
const ops: Record<string, Op> = {
  // lifecycle
  status: () => status,
  pair: (code: string) => pair(code),
  unpair: () => unpair(),
  // Explicit "sync now" (settings button, online/visibility triggers): force a
  // push so pending edits flush immediately. The edit-debounce + 15s poll use
  // the unforced path so a burst of edits batches into one segment.
  sync: () => runSync(true).then(() => status.lastSync),

  // storage-sync (S3/R2): add a bucket peer for store-and-forward sync. The
  // settings page passes the bucket config + passphrase; we provision (fetch or
  // create the wrapped master key in the bucket), persist the resolved peer,
  // then run a round so bad credentials / missing CORS surface immediately.
  addStorageReplica: async (config: S3Config, passphrase: string) => {
    const d = requireDb();
    // A browser replica holds the full hydrated hub, so it can publish whole-hub
    // snapshots. Default to publisher so a bucket attached here never stays empty
    // (the original footgun); callers pass publish:false for an origin replica
    // that only wants the bucket for its own away-sync. A lease + priority
    // (publisher-lease.ts) makes a server, when present, win publishing duty.
    const cfg: S3Config = { publish: true, priority: 10, ...config };
    if (cfg.encrypt)
      cfg.masterKey = (await provisionMasterKey(storageClientFor(cfg), cfg, passphrase)) ?? undefined;
    // Same derivation as the CLI/server (addAndSyncStoragePeer) — one shared
    // helper so the WebUI can't mint a divergent key the migration would then
    // chase forever.
    const url = storageUrl(cfg.endpoint, cfg.bucket, cfg.prefix);
    if (syncing) await syncing;
    const previous = getPeer(d, url);
    addStoragePeer(d, { url, config: cfg, label: cfg.bucket });
    await runSync(true);
    if (status.bucketError) {
      if (previous) restorePeerRow(d, previous);
      else removePeer(d, url);
      throw new MhError("network", `storage peer first sync failed: ${status.bucketError}`);
    }
    return { url, lastSync: status.lastSync };
  },
  removeStorageReplica: (url: string) => ({ ok: removePeer(requireDb(), url) }),
  // The bucket config (with credentials) for one storage peer — used by the
  // settings page to build a "open on your phone" enroll QR. Local-only data,
  // same origin as the page that asks; the passphrase is never stored here.
  storagePeerConfig: (url: string): S3Config | null => {
    const p = getPeer(db!, url);
    return p?.config ? (JSON.parse(p.config) as S3Config) : null;
  },
  listStoragePeers: () =>
    listPeers(db!)
      .filter((p) => p.kind === "s3")
      .map((p) => ({
        url: p.url,
        label: p.label,
        enabled: p.enabled === 1,
        status: p.last_status,
        error: p.last_error,
        lastSyncAt: p.last_success_at,
        lastAttemptAt: p.last_sync_at,
      })),

  // databases
  listDatabases: () => listDatabases(db!),
  createDatabase: (b: { name: string; icon?: string }) => createDatabase(db!, b),
  updateDatabase: (id: string, b: { name?: string; icon?: string | null }) =>
    updateDatabase(db!, id, b),
  duplicateDatabase: (id: string, b?: { name?: string; icon?: string }) =>
    duplicateDatabase(db!, id, b ?? {}),
  deleteDatabase: (id: string) => ({ ok: deleteDatabase(db!, id) }),
  listDatabaseActivity: (dbId: string, limit?: number) =>
    listDatabaseActivity(db!, dbId, { limit }),

  // properties
  listProperties: (dbId: string) => listProperties(db!, dbId),
  addProperty: (dbId: string, b: { name: string; type: PropType; config?: PropertyConfig }) =>
    addProperty(db!, dbId, b),
  updateProperty: (
    id: string,
    b: { name?: string; type?: PropType; config?: PropertyConfig; position?: number },
  ) => updateProperty(db!, id, b),
  setPropertyWidth: (id: string, width: number) => setPropertyWidth(db!, id, width),
  removeProperty: (id: string) => ({ ok: removeProperty(db!, id) }),
  listPropertyRevisions: (id: string) => listPropertyRevisions(db!, id),
  revertProperty: (id: string, to: string) => revertProperty(db!, id, to),

  // records
  listRecords: (dbId: string, opts?: { sort?: string; limit?: number }) =>
    listRecords(db!, dbId, opts ?? {}),
  createRecord: (dbId: string, values: Record<string, unknown>) =>
    createRecord(db!, dbId, values),
  getRecord: (id: string) => {
    const rec = getRecord(db!, id);
    if (!rec) throw new MhError("not_found", `no such record: ${id}`);
    return rec;
  },
  updateRecord: (id: string, values: Record<string, unknown>) => updateRecord(db!, id, values),
  moveRecord: (id: string, target: string, where: "before" | "after") =>
    moveRecord(db!, id, target, where),
  deleteRecord: (id: string) => ({ ok: deleteRecord(db!, id) }),
  listRecordRevisions: (id: string) => listRecordRevisions(db!, id),
  recordAtVersion: (id: string, version: string) => recordAtVersion(db!, id, version),
  recordFieldHistory: (id: string, prop: string) => recordFieldHistory(db!, id, prop),
  revertRecord: (id: string, to: string) => revertRecord(db!, id, to),

  // documents
  listDocuments: (filter?: { database_id?: string; parent_id?: string }) =>
    listDocuments(db!, filter ?? {}),
  createDocument: (b: {
    title: string;
    body?: string;
    database_id?: string;
    parent_id?: string;
  }) => createDocument(db!, b),
  getDocument: (id: string) => {
    const doc = getDocument(db!, id);
    if (!doc) throw new MhError("not_found", `no such document: ${id}`);
    return { ...doc, version: documentVersion(db!, doc.id) };
  },
  updateDocument: (
    id: string,
    fields: { title?: string; body?: string; parent_id?: string | null },
    ifMatch?: string,
  ) => {
    const doc = updateDocument(db!, id, fields, { ifMatch });
    return { ...doc, version: documentVersion(db!, doc.id) };
  },
  duplicateDocument: (id: string, b?: { title?: string; parent_id?: string | null }) => {
    const doc = duplicateDocument(db!, id, { title: b?.title, parentId: b?.parent_id });
    return { ...doc, version: documentVersion(db!, doc.id) };
  },
  moveDocument: (id: string, target: string, where: "before" | "after" | "into") =>
    moveDocument(db!, id, target, where),
  listDocumentRevisions: (id: string) => listDocumentRevisions(db!, id),
  documentAtVersion: (id: string, version: string) => documentAtVersion(db!, id, version),
  revertDocument: (id: string, to: string, ifMatch?: string) =>
    revertDocument(db!, id, to, { ifMatch }),
  deleteDocument: (id: string) => ({ ok: deleteDocument(db!, id) }),

  // sites (offline serving: the SW asks for raw rows; blob-encoded content
  // can't replicate — its bytes live in the server's on-disk store — so it
  // resolves null and 404s offline)
  siteFile: async (
    name: string,
    path: string,
  ): Promise<{ content_type: string; encoding: FileEncoding; content: string | null } | null> => {
    // ②b: the served page is non-reactive, so re-pull before serving when the
    // local replica is very stale. runSync coalesces, so a navigation's many
    // subresource requests share one in-flight sync.
    const age = status.lastSync?.at ? Date.now() - status.lastSync.at : Infinity;
    if (age > SITE_FRESH_MAX_AGE_MS) await runSync(true).catch(() => {});
    const d = db!;
    let siteId: string;
    try {
      siteId = resolveSite(d, name).id;
    } catch {
      return null;
    }
    const row = getFileRow(d, siteId, path);
    if (!row || row.encoding === "blob") return null;
    return row;
  },

  // blob bytes (offline document images): the SW asks for a blob's bytes by hash
  // when neither its local Cache Storage nor the network had them. We answer from
  // the local spool (bytes composed offline) or by pulling + decrypting them from
  // an attached bucket — the only byte source a browser replica can reach. Returns
  // an ArrayBuffer (structured-cloned back to the SW) or null when unreachable.
  blobBytes: async (hash: string): Promise<ArrayBuffer | null> => {
    const sp = await spoolGet(hash).catch(() => undefined);
    if (sp) return sp.bytes;
    for (const peer of enabledStoragePeers(db!)) {
      if (!peer.config) continue;
      try {
        const bytes = await getBucketBlob(JSON.parse(peer.config) as S3Config, hash);
        if (bytes && (await verifyBytes(bytes, hash))) return new Uint8Array(bytes).buffer;
      } catch {
        // bucket unreachable / decrypt failure — try the next peer
      }
    }
    return null;
  },

  // blob references (no-origin blob manager): every hash a live document or site
  // still points at, so the popup can mark which locally-cached blobs are orphans.
  blobRefs: (): string[] => [...referencedHashes(db!)],

  // sites management (offline / no-origin): portable read+write paths so the
  // browser replica lists, creates, edits and deletes sites with no server.
  // Large-binary blob uploads are server-only (putFileInline throws on them).
  listSites: () => listSites(db!).map((s) => ({ ...s, file_count: fileCount(db!, s.id) })),
  listSiteFiles: (siteId: string) => listFiles(db!, siteId),
  createSite: (b: { name: string; title?: string }) => ({ ...createSite(db!, b), file_count: 0 }),
  updateSite: (id: string, b: { name?: string; title?: string }) => ({
    ...updateSite(db!, id, b),
    file_count: fileCount(db!, id),
  }),
  deleteSite: (id: string) => ({ ok: deleteSite(db!, id) }),
  putSiteFile: (siteId: string, path: string, data: ArrayBuffer | string, contentType?: string) => {
    const { content: _content, ...row } = putFileInline(db!, siteId, path, { data, contentType });
    return row; // SiteFile shape (content withheld from the UI, like the HTTP route)
  },
  deleteSiteFile: (siteId: string, path: string) => ({ ok: deleteFile(db!, siteId, path) }),

  // wipe the local replica (settings → 重置本地副本): close the db, delete its
  // OPFS files, then re-open a fresh empty db. A single-tab page terminates this
  // worker right after; but a worker shared across tabs survives, so we must NOT
  // leave `db` null — re-enabling ("信任此设备" → pair) would land on this same
  // worker and deref null. Re-opening leaves it immediately usable + empty.
  reset: async () => {
    try {
      oo1Db?.close();
    } catch {
      /* already closed */
    }
    db = null;
    await pool?.wipeFiles();
    openDb();
    setStatus({
      state: "ready",
      paired: false,
      node: getNodeId(requireDb()),
      hydrated: undefined,
      lastSync: undefined,
    });
    return { ok: true };
  },

  // nodes + search
  nodes: () => {
    const d = db!;
    const selfNode = getNodeId(d);
    const peers = d
      .query(
        "SELECT node_id, label FROM peers WHERE node_id IS NOT NULL AND node_id <> '' GROUP BY node_id",
      )
      .all() as { node_id: string; label: string | null }[];
    return [
      { node_id: selfNode, label: null, self: true },
      ...peers.filter((p) => p.node_id !== selfNode).map((p) => ({ ...p, self: false })),
    ];
  },
  search: (text: string, limit?: number) => search(db!, text, { limit }),
};

/** Ops that change data: a successful call schedules a push to the server. */
const MUTATING = /^(create|update|delete|move|duplicate|revert|add|remove|set|put)/;

let pushTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePush(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (navigator.onLine !== false) void runSync();
  }, 800);
}

// ---- dispatcher ----------------------------------------------------------------

self.onmessage = async (e: MessageEvent) => {
  const { id, op, args } = e.data as RpcRequest;
  try {
    await ready;
    const fn = ops[op];
    if (!fn) throw new MhError("invalid_input", `unknown op: ${op}`);
    const result = await fn(...(args ?? []));
    post({ id, ok: true, result });
    if (MUTATING.test(op)) {
      markBucketDirty();
      schedulePush();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = errorCode(err) ?? undefined;
    post({ id, ok: false, error: { message, code } });
  }
};
