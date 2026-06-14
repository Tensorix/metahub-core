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
import { syncWithPeer } from "../../core/sync/client.ts";
import {
  addPeer,
  getPeer,
  removePeer,
  listPeers,
  addStoragePeer,
  syncPeer,
} from "../../core/sync/peers.ts";
import { provisionMasterKey, storageClientFor, type S3Config } from "../../core/sync/storage.ts";
import "./storage-s3-browser.ts"; // side effect: register the browser SigV4 S3 client
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
import { resolveSite, getFileRow, type FileEncoding } from "../../core/sites-core.ts";

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

// ---- boot ----------------------------------------------------------------------

let poolUtil: { wipeFiles(): Promise<unknown> } | null = null;
let oo1Db: { close(): void } | null = null;

const ready: Promise<void> = (async () => {
  // No init options: the emscripten glue resolves sqlite3.wasm relative to
  // import.meta.url, which for the bundled worker (/db-worker.js) is exactly
  // the /sqlite3.wasm the server provides.
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "metahub-replica" });
  poolUtil = pool as unknown as { wipeFiles(): Promise<unknown> };
  const oo1 = new pool.OpfsSAHPoolDb("/metahub.db") as unknown as Oo1Db & { close(): void };
  oo1Db = oo1;
  const driver = new WasmDriver(oo1);
  initSchema(driver);
  db = driver;
  const node = getNodeId(driver);
  const paired = getPeer(driver, origin)?.token != null;
  setStatus({ state: "ready", node, paired });
})().catch((e) => {
  setStatus({ state: "error", error: e instanceof Error ? e.message : String(e) });
  throw e;
});

// ---- sync loop -----------------------------------------------------------------

let syncing: Promise<void> | null = null;

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

/** Push-batching for storage peers: coalesce edits into ~one segment per
 *  STORAGE_PUSH_AGE_MS (or per STORAGE_PUSH_MIN_CHANGES) instead of a tiny
 *  object per debounce, which costs a billed request + a GET for every puller.
 *  `force` (explicit "sync now") bypasses the thresholds so edits never strand. */
const STORAGE_PUSH_MIN_CHANGES = 25;
const STORAGE_PUSH_AGE_MS = 10_000;

async function runSync(force = false): Promise<void> {
  if (!db) return;
  const d = db;
  if (!hasSyncTarget(d)) return;
  if (syncing) return syncing;
  syncing = (async () => {
    const before = (
      d.query("SELECT MAX(rowid) AS m FROM crdt_changes").get() as { m: number | null }
    ).m ?? 0;

    let pushed = 0;
    let pulled = 0;
    const errors: string[] = [];

    // Origin server (http), chunked initial hydration — only if paired. Its
    // failure (server offline) must not stop storage-peer sync below.
    if (getPeer(d, origin)?.token != null) {
      try {
        for (;;) {
          const r = await syncWithPeer(d, origin, { pullLimit: PULL_LIMIT });
          pushed += r.pushed;
          pulled += r.pulled;
          if (r.pulled < PULL_LIMIT) break;
          setStatus({ state: "hydrating", hydrated: pulled });
        }
      } catch (e) {
        errors.push(`server: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Storage (s3) peers — each captures its own error into last_status.
    for (const peer of listPeers(d)) {
      if (peer.enabled !== 1 || peer.kind !== "s3") continue;
      const out = await syncPeer(d, peer.url, {
        storage: {
          minPushChanges: STORAGE_PUSH_MIN_CHANGES,
          maxPushAgeMs: STORAGE_PUSH_AGE_MS,
          forcePush: force,
        },
      });
      if (out.ok) {
        pushed += out.pushed ?? 0;
        pulled += out.pulled ?? 0;
      } else {
        errors.push(`${peer.label ?? peer.url}: ${out.error}`);
      }
    }

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
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

setInterval(() => {
  if (navigator.onLine !== false) void runSync();
}, SYNC_INTERVAL_MS);

// ---- pairing -------------------------------------------------------------------

/** Self-service pairing: the page (already holding the master token) minted a
 *  one-time code via POST /api/pair/new and hands it here; we redeem it for a
 *  durable, individually-revocable grant and store it as our peer credential.
 *  No self_url: the server must not register an unreachable browser as an
 *  outbound peer. (pairing.ts's performPairing isn't reused — it reads
 *  process.env at module load, which a browser bundle can't.) */
async function pair(code: string): Promise<{ node_id: string }> {
  const d = db!;
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
  const ok = removePeer(db!, origin);
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
    const d = db!;
    const cfg: S3Config = { ...config };
    if (cfg.encrypt)
      cfg.masterKey = (await provisionMasterKey(storageClientFor(cfg), cfg, passphrase)) ?? undefined;
    const url = `s3://${cfg.bucket}/${cfg.prefix}`;
    addStoragePeer(d, { url, config: cfg, label: cfg.bucket });
    await runSync();
    return { url, lastSync: status.lastSync };
  },
  removeStorageReplica: (url: string) => ({ ok: removePeer(db!, url) }),
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
        lastSyncAt: p.last_sync_at,
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
  siteFile: (
    name: string,
    path: string,
  ): { content_type: string; encoding: FileEncoding; content: string | null } | null => {
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

  // wipe the local replica (settings → 重置本地副本): close the pool and
  // delete its OPFS files; the page terminates this worker afterwards.
  reset: async () => {
    try {
      oo1Db?.close();
    } catch {
      /* already closed */
    }
    db = null;
    await poolUtil?.wipeFiles();
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
const MUTATING = /^(create|update|delete|move|duplicate|revert|add|remove|set)/;

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
    if (MUTATING.test(op)) schedulePush();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = errorCode(err) ?? undefined;
    post({ id, ok: false, error: { message, code } });
  }
};
