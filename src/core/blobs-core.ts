// Portable (driver-only) half of the blob ledger: policy, presence, the offline
// "is this cached blob safe to clear?" judgment, the reference index, and the
// node-local blob_cache bookkeeping. No node:fs / Bun here, so a browser worker
// can read the same judgment. The byte-touching half (delete from disk, resolve
// missing bytes over the network) lives in blobs.ts.
//
// Model: blob bytes are content-addressed (cache.ts). A device may CLEAR a local
// blob's bytes only when a durable anchor is designated (blob_policy.fullNodes)
// AND the blob is not this node's own not-yet-flushed production — so the
// reference (hash, kept in the oplog) stays re-fetchable. A device that is itself
// a full node, or ANY device while no full node is designated, never clears (the
// safety floor: with no anchor there is no guaranteed holder, so a cache copy may
// be the last copy). Durability is judged locally via blob_cache.pending; see
// docs/impl-context/22-blob-sync (D4, safety-floor revision).

import type { DbDriver } from "./driver.ts";
import { emit, withChangeGroup } from "./crdt.ts";
import { getNodeId, getNodeLabel } from "./node.ts";

export const POLICY_ID = "default";

/** Fetch a blob's bytes by content hash, from wherever this runtime can reach
 *  them. Registered per runtime (same adapter shape as room-peer.ts's
 *  registerRoomBlobResolver): Bun resolves local cache → HTTP peers → buckets
 *  (blobs.ts resolveBlob), the browser replica resolves OPFS spool → buckets
 *  (db-worker.ts browserRoomBlob). Declared here, in the driver-only half, so
 *  runtime-neutral callers reachable from BOTH the server and the browser
 *  (share-export.ts) can ask for bytes without importing blobs.ts — which would
 *  drag node:fs / Bun.file into the browser bundle. */
export type BlobBytesResolver = (db: DbDriver, hash: string) => Promise<Uint8Array | null>;
let blobBytesResolver: BlobBytesResolver | null = null;

/** `null` unregisters (tests restoring global state; a runtime tearing down). */
export function setBlobBytesResolver(f: BlobBytesResolver | null): void {
  blobBytesResolver = f;
}

/** Bytes for `hash`, or null when unreachable — or when no resolver is
 *  registered (treated like "unreachable": callers already skip blobs they
 *  can't fetch rather than failing the whole operation). */
export function resolveBlobBytes(db: DbDriver, hash: string): Promise<Uint8Array | null> {
  return blobBytesResolver ? blobBytesResolver(db, hash) : Promise.resolve(null);
}

/** Whether this runtime wired up a resolver at all. Callers that would otherwise
 *  read "no resolver" as "every blob is unreachable" check this first, so a
 *  wiring mistake fails loudly instead of silently shipping a blob-less result. */
export function hasBlobBytesResolver(): boolean {
  return blobBytesResolver !== null;
}

export type Redundancy = "all" | "any";

export interface BlobPolicy {
  fullNodes: string[];
  redundancy: Redundancy;
}

export interface CachedBlob {
  hash: string;
  size: number;
  content_type: string | null;
  last_access: number | null;
  /** Node-local pin: 1 = never auto-evicted / cleared (does not sync). */
  pinned: number;
  /** 1 = bytes produced here, not yet flushed to a durable anchor — protected. */
  pending: number;
  /** Node-local: 1 = the last presence verify confirmed a designated anchor holds
   *  this blob (per redundancy). Drives isClearable; reset to 0 on policy change. */
  anchored: number;
}

export interface CacheStats {
  /** Total bytes currently held in the node-local cache. */
  totalBytes: number;
  /** Bytes safe to clear (durable on the required full set). */
  clearableBytes: number;
  /** Bytes that cannot be cleared (sole copy / no anchor / this is a full node). */
  retainedBytes: number;
  count: number;
  clearableCount: number;
}

// ---- policy -----------------------------------------------------------------

export function readPolicy(db: DbDriver): BlobPolicy {
  const row = db
    .query("SELECT full_nodes, redundancy FROM blob_policy WHERE id = ? AND __deleted = 0")
    .get(POLICY_ID) as { full_nodes: string | null; redundancy: string | null } | null;
  let fullNodes: string[] = [];
  if (row?.full_nodes) {
    try {
      const parsed = JSON.parse(row.full_nodes);
      if (Array.isArray(parsed)) fullNodes = parsed.filter((n) => typeof n === "string");
    } catch {
      // malformed — treat as none designated
    }
  }
  const redundancy: Redundancy = row?.redundancy === "any" ? "any" : "all";
  return { fullNodes, redundancy };
}

/** Designate the full-blob anchors (synced workspace policy). Each entry is
 *  either a node id (a device that keeps everything) OR a bucket url `s3://…`
 *  (object storage as a durable full library). Bucket urls never match a node id,
 *  so isFullBlobNode()/isClearable() are unaffected — they're a visible guardrail. */
export const setFullNodes = (db: DbDriver, nodeIds: string[]): void => {
  withChangeGroup(null, () => {
    // de-dupe, keep order
    const seen = new Set<string>();
    const list = nodeIds.filter((n) => n && !seen.has(n) && seen.add(n) != null);
    emit(db, "blob_policy", POLICY_ID, "full_nodes", list);
    // ensure redundancy has a concrete value on first designation
    const cur = readPolicy(db);
    if (cur.redundancy == null) emit(db, "blob_policy", POLICY_ID, "redundancy", "all");
  });
  invalidateAnchored(db); // anchor set changed → prior verify verdict is stale
};

export const setRedundancy = (db: DbDriver, redundancy: Redundancy): void => {
  emit(db, "blob_policy", POLICY_ID, "redundancy", redundancy);
  invalidateAnchored(db); // any/all changed → re-verify before anything is clearable
};

/** Is `node` (default: this device) a designated full-blob library? */
export function isFullBlobNode(db: DbDriver, node?: string): boolean {
  const id = node ?? getNodeId(db);
  return readPolicy(db).fullNodes.includes(id);
}

// ---- clear judgment ---------------------------------------------------------

/**
 * Whether this device may safely drop `hash`'s local bytes — a purely LOCAL,
 * offline decision read from local flags. Clearable requires ALL of:
 *  1. This node is not itself the full-blob library (a full node keeps everything).
 *  2. The blob is not a `pending` production (bytes produced here, not yet flushed
 *     to an anchor) — the only locally-unique copy.
 *  3. `anchored == 1`: the last presence verify confirmed a designated anchor holds
 *     this blob, per redundancy(any/all). Until a verify runs (or after a policy
 *     change resets it), anchored is 0 → nothing is clearable (conservative). This
 *     replaces the earlier coarse "an anchor is designated" floor with a per-blob,
 *     freshly-verified fact. See verifyAnchorPresence (blobs.ts) and
 *     docs/impl-context/22-blob-sync (D4, on-demand presence verify).
 */
export function isClearable(db: DbDriver, hash: string): boolean {
  if (isFullBlobNode(db)) return false; // this node IS the full library → keeps everything
  const row = db
    .query("SELECT pending, anchored FROM blob_cache WHERE hash = ?")
    .get(hash) as { pending: number; anchored: number } | null;
  return !!row && row.pending === 0 && row.anchored === 1;
}

// ---- verified-presence bookkeeping (node-local) -----------------------------

/** Record/clear the per-blob "a designated anchor verifiably holds this" flag. */
export function setAnchored(db: DbDriver, hash: string, anchored: boolean): void {
  db.query("UPDATE blob_cache SET anchored = ? WHERE hash = ?").run(anchored ? 1 : 0, hash);
}

export function isAnchored(db: DbDriver, hash: string): boolean {
  const row = db.query("SELECT anchored FROM blob_cache WHERE hash = ?").get(hash) as
    | { anchored: number }
    | null;
  return !!row && row.anchored === 1;
}

/** Drop every verified verdict (after a policy change) — forces a re-verify before
 *  anything is clearable again. Also clears the last-verified stamp. */
export function invalidateAnchored(db: DbDriver): void {
  db.query("UPDATE blob_cache SET anchored = 0").run();
  db.query("DELETE FROM meta WHERE key = ?").run(BLOB_VERIFIED_AT_KEY);
}

const BLOB_VERIFIED_AT_KEY = "blob_verified_at";

/** Epoch-ms of the last successful presence verify, or null if never / invalidated. */
export function readBlobVerifiedAt(db: DbDriver): number | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(BLOB_VERIFIED_AT_KEY) as
    | { value: string }
    | null;
  return row ? Number(row.value) : null;
}

export function writeBlobVerifiedAt(db: DbDriver, ts: number): void {
  db.query(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(BLOB_VERIFIED_AT_KEY, String(ts));
}

// ---- reference index --------------------------------------------------------

/** Matches a doc image reference `/blob/<hash>` (canonical 32-hex or legacy
 *  64-hex). Works on raw markdown and JSON-encoded oplog values alike. */
const DOC_BLOB_REF = /\/blob\/([0-9a-f]{16,64})/g;

/** Blob hashes referenced by a `/blob/<hash>` URL inside a markdown/text value. */
export function blobRefsIn(text: string | null): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(DOC_BLOB_REF)) out.push(m[1]!);
  return out;
}

/**
 * Every blob hash a live document or site still points at. Union of:
 *  - site_files rows stored as a blob (content = hash), and
 *  - `/blob/<hash>` references inside live doc_blocks markdown (doc images).
 * Drives GC (orphan = not in this set) and a full node's byte acquisition.
 */
export function referencedHashes(db: DbDriver): Set<string> {
  const out = new Set<string>();
  const files = db
    .query("SELECT content FROM site_files WHERE encoding = 'blob' AND __deleted = 0")
    .all() as { content: string | null }[];
  for (const f of files) if (f.content) out.add(f.content);

  const blocks = db
    .query("SELECT text FROM doc_blocks WHERE __deleted = 0 AND text LIKE '%/blob/%'")
    .all() as { text: string | null }[];
  for (const b of blocks) for (const h of blobRefsIn(b.text)) out.add(h);
  return out;
}

// ---- node-local cache ledger (blob_cache) -----------------------------------

/** Record/refresh a blob's ledger row after its bytes land in the cache. */
/** Record/refresh a cached blob. `pending`: 1 for bytes PRODUCED here (must flush
 *  to an anchor before they're clearable), 0 for an ACQUIRED cache copy (already
 *  durable at its source). */
export function recordBlob(
  db: DbDriver,
  hash: string,
  size: number,
  contentType?: string | null,
  pending = 1,
): void {
  db.query(
    `INSERT INTO blob_cache (hash, size, content_type, last_access, pending)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(hash) DO UPDATE SET
       size = excluded.size,
       content_type = coalesce(excluded.content_type, blob_cache.content_type),
       last_access = excluded.last_access,
       pending = excluded.pending`,
  ).run(hash, size, contentType ?? null, Date.now(), pending ? 1 : 0);
}

/** Mark a blob flushed (0) or pending (1). Flush is set after the bytes are
 *  confirmed at the durable anchor (see blobs.ts blobMaintenance). */
export function setPending(db: DbDriver, hash: string, pending: boolean): void {
  db.query("UPDATE blob_cache SET pending = ? WHERE hash = ?").run(pending ? 1 : 0, hash);
}

/** Bump last_access on a cache hit (LRU signal for stats/future eviction). */
export function touchBlob(db: DbDriver, hash: string): void {
  db.query("UPDATE blob_cache SET last_access = ? WHERE hash = ?").run(Date.now(), hash);
}

export function forgetBlob(db: DbDriver, hash: string): void {
  db.query("DELETE FROM blob_cache WHERE hash = ?").run(hash);
}

export function cachedBlobs(db: DbDriver): CachedBlob[] {
  return db
    .query("SELECT hash, size, content_type, last_access, pinned, pending, anchored FROM blob_cache")
    .all() as CachedBlob[];
}

/** Blobs produced here that are not yet flushed to a durable anchor (the upload
 *  worklist; steady state is empty). */
export function pendingBlobs(db: DbDriver): { hash: string; size: number }[] {
  return db
    .query("SELECT hash, size FROM blob_cache WHERE pending = 1")
    .all() as { hash: string; size: number }[];
}

/** Pin/unpin a cached blob (node-local; never synced). Returns true when a row
 *  was updated (false when the hash isn't in the ledger). */
export function setPinned(db: DbDriver, hash: string, pinned: boolean): boolean {
  return (
    db.query("UPDATE blob_cache SET pinned = ? WHERE hash = ?").run(pinned ? 1 : 0, hash)
      .changes > 0
  );
}

/** Is a cached blob pinned? (false when not in the ledger). */
export function isPinned(db: DbDriver, hash: string): boolean {
  const row = db
    .query("SELECT pinned FROM blob_cache WHERE hash = ?")
    .get(hash) as { pinned: number } | null;
  return !!row?.pinned;
}

/** Recorded content type for a cached blob (null when unknown / not cached). */
export function blobContentType(db: DbDriver, hash: string): string | null {
  const row = db
    .query("SELECT content_type FROM blob_cache WHERE hash = ?")
    .get(hash) as { content_type: string | null } | null;
  return row?.content_type ?? null;
}

export function cacheStats(db: DbDriver): CacheStats {
  const blobs = cachedBlobs(db);
  let totalBytes = 0;
  let clearableBytes = 0;
  let clearableCount = 0;
  for (const b of blobs) {
    totalBytes += b.size;
    if (isClearable(db, b.hash)) {
      clearableBytes += b.size;
      clearableCount++;
    }
  }
  return {
    totalBytes,
    clearableBytes,
    retainedBytes: totalBytes - clearableBytes,
    count: blobs.length,
    clearableCount,
  };
}

// ---- device roster (for designating full nodes) -----------------------------

export interface KnownNode {
  nodeId: string;
  label: string | null;
  self: boolean;
}

/** Distinct node ids this device knows about (self + outbound peers + grantees),
 *  for the "pick a full-blob device" selector in Settings / CLI. */
export function knownNodes(db: DbDriver): KnownNode[] {
  const self = getNodeId(db);
  const byId = new Map<string, string | null>();
  byId.set(self, getNodeLabel(db));
  const peers = db
    .query("SELECT node_id, label FROM peers WHERE node_id IS NOT NULL")
    .all() as { node_id: string; label: string | null }[];
  for (const p of peers) if (!byId.get(p.node_id)) byId.set(p.node_id, p.label ?? byId.get(p.node_id) ?? null);
  const grants = db
    .query("SELECT DISTINCT node_id FROM peer_grants WHERE node_id IS NOT NULL")
    .all() as { node_id: string }[];
  for (const g of grants) if (!byId.has(g.node_id)) byId.set(g.node_id, null);
  return [...byId.entries()].map(([nodeId, label]) => ({ nodeId, label, self: nodeId === self }));
}
