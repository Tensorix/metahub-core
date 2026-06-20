// Node-only half of the blob ledger: the pieces that touch the on-disk cache
// (delete bytes, reconcile legacy files) or the network (resolve missing bytes —
// added with the transport layer). Re-exports blobs-core.ts so server-side
// callers import everything from here.

import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import type { DbDriver } from "./driver.ts";
import { cacheDir } from "./paths.ts";
import { deleteBlob, getBlob, putBlobAt, verifyBlobBytes } from "./cache.ts";
import { listPeers } from "./sync/peers.ts";
import { type S3Config, getBucketBlob, putBucketBlob, listBucketBlobHashes } from "./sync/storage.ts";
import { getServerConfig } from "./config.ts";
import { getNodeId } from "./node.ts";
import {
  cachedBlobs,
  isClearable,
  forgetBlob,
  recordBlob,
  touchBlob,
  referencedHashes,
  pendingBlobs,
  setPending,
  isFullBlobNode,
  readPolicy,
  setAnchored,
  writeBlobVerifiedAt,
} from "./blobs-core.ts";

export * from "./blobs-core.ts";

export interface KnownBucket {
  url: string;
  label: string | null;
  bucket: string | null;
}

/** Attached object-storage buckets (s3 peers), for the "pick a full-blob anchor"
 *  selector in Settings. A bucket is a durable full-blob library but is NOT a node
 *  (1:N store-and-forward, no single node id), so it lives alongside knownNodes()
 *  rather than inside it — designated by its synthetic url, not a node_id. */
export function knownBuckets(db: DbDriver): KnownBucket[] {
  return listPeers(db)
    .filter((p) => p.kind === "s3" && p.config)
    .map((p) => {
      let bucket: string | null = null;
      try {
        bucket = (JSON.parse(p.config!) as S3Config).bucket ?? null;
      } catch {
        // malformed config — show url only
      }
      return { url: p.url, label: p.label, bucket };
    });
}

// ---- byte transport: on-demand resolution + full-node maintenance -----------

/** Cache bytes fetched for a reference (by the ref's own hash — which may be a
 *  legacy 64-hex that putBlob's truncation would not reproduce). */
async function storeFetched(db: DbDriver, hash: string, bytes: Uint8Array): Promise<void> {
  await putBlobAt(hash, bytes);
  recordBlob(db, hash, bytes.byteLength, null, 0); // acquired cache → already durable at its source
}

/**
 * Resolve a blob's bytes by content hash: local cache → each enabled HTTP peer's
 * `GET /blob/<hash>?local=1` (local=1 keeps the peer from re-resolving, so there
 * are no fetch loops) → each attached bucket's `blobs/<hash>`. Content-addressed,
 * so every source is verified by re-hashing and any source is interchangeable.
 * The first verified hit is cached locally and returned; null when unreachable.
 */
export async function resolveBlob(db: DbDriver, hash: string): Promise<Uint8Array | null> {
  const local = await getBlob(hash);
  if (local) {
    touchBlob(db, hash);
    return local;
  }
  for (const peer of listPeers(db)) {
    if (!peer.enabled) continue;
    try {
      if (peer.kind === "s3") {
        if (!peer.config) continue;
        const bytes = await getBucketBlob(JSON.parse(peer.config) as S3Config, hash);
        if (bytes && verifyBlobBytes(bytes, hash)) {
          await storeFetched(db, hash, bytes);
          return bytes;
        }
      } else {
        const res = await fetch(new URL(`/blob/${hash}?local=1`, peer.url), {
          headers: peer.token ? { authorization: `Bearer ${peer.token}` } : {},
        });
        if (!res.ok) continue;
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (verifyBlobBytes(bytes, hash)) {
          await storeFetched(db, hash, bytes);
          return bytes;
        }
      }
    } catch {
      // unreachable / error — try the next source
    }
  }
  return null;
}

// ---- on-demand presence verify (drives isClearable's `anchored`) -------------

export interface VerifyResult {
  /** Blobs confirmed durable on the anchor set (per redundancy) → clearable. */
  anchoredCount: number;
  anchoredBytes: number;
  /** Designated anchors (bucket urls / device node ids) we could not reach to
   *  check. Under `all`, any unreachable anchor makes everything un-clearable. */
  unreachable: string[];
  /** Epoch-ms this verify ran. */
  at: number;
}

/** Ask a designated full-blob DEVICE anchor which of `hashes` it holds. */
async function queryPeerHas(
  url: string,
  token: string | null,
  hashes: string[],
): Promise<Set<string>> {
  const res = await fetch(new URL("/api/blobs/has", url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ hashes }),
  });
  if (!res.ok) throw new Error(`/api/blobs/has → ${res.status}`);
  const data = (await res.json()) as { has?: string[] };
  return new Set(data.has ?? []);
}

/**
 * Verify, right now, which locally-cached blobs a designated anchor durably holds,
 * and record the per-blob `anchored` flag that `isClearable` reads. Buckets are
 * checked with one paginated LIST (listBucketBlobHashes); device anchors with a
 * `POST /api/blobs/has`. An anchor we can't reach (offline / no stored url+token /
 * bad creds) goes into `unreachable` and is treated as NOT holding anything —
 * conservative, so a transient outage defers clearing rather than risking loss.
 *
 * Redundancy: `any` → present on ≥1 reachable anchor; `all` → every designated
 * anchor reachable AND holding it. Run on demand only (panel open / refresh /
 * pre-eviction when over quota), never in the steady-state maintenance loop.
 */
export async function verifyAnchorPresence(db: DbDriver): Promise<VerifyResult> {
  const policy = readPolicy(db);
  const self = getNodeId(db);
  const anchors = policy.fullNodes.filter((a) => a !== self);
  const blobs = cachedBlobs(db);
  const at = Date.now();

  if (anchors.length === 0) {
    for (const b of blobs) setAnchored(db, b.hash, false);
    writeBlobVerifiedAt(db, at);
    return { anchoredCount: 0, anchoredBytes: 0, unreachable: [], at };
  }

  const peers = listPeers(db);
  const localHashes = blobs.map((b) => b.hash);
  const anchorSets: Set<string>[] = [];
  const unreachable: string[] = [];

  for (const a of anchors) {
    let set: Set<string> | null = null;
    try {
      if (a.startsWith("s3://")) {
        const peer = peers.find((p) => p.url === a && p.kind === "s3" && p.config);
        if (peer) set = await listBucketBlobHashes(JSON.parse(peer.config!) as S3Config);
      } else {
        const peer = peers.find((p) => p.node_id === a && p.kind !== "s3" && p.url);
        if (peer) set = await queryPeerHas(peer.url, peer.token, localHashes);
      }
    } catch {
      set = null; // unreachable / error
    }
    if (set) anchorSets.push(set);
    else unreachable.push(a);
  }

  const allReachable = unreachable.length === 0;
  let anchoredCount = 0;
  let anchoredBytes = 0;
  for (const b of blobs) {
    const presentIn = anchorSets.reduce((n, s) => n + (s.has(b.hash) ? 1 : 0), 0);
    const ok =
      policy.redundancy === "all"
        ? allReachable && presentIn === anchors.length // every designated anchor holds it
        : presentIn >= 1; // any reachable anchor holds it
    setAnchored(db, b.hash, ok);
    if (ok) {
      anchoredCount++;
      anchoredBytes += b.size;
    }
  }
  writeBlobVerifiedAt(db, at);
  return { anchoredCount, anchoredBytes, unreachable, at };
}

export interface BlobMaintenanceResult {
  /** Referenced blobs a full library pulled in this round. */
  acquired: number;
  /** Pending productions confirmed flushed to the bucket(s) this round. */
  flushed: number;
  /** Blobs auto-evicted to stay under the configured cache quota. */
  evicted: number;
}

/**
 * Background blob upkeep, run from the sync tick (throttled). Cheap in steady
 * state — it only touches work that actually exists:
 *  1. A full blob library pulls every referenced blob it is still MISSING
 *     (resolveBlob); self-limiting, a no-op once caught up.
 *  2. This node flushes its own PENDING productions to each attached bucket, then
 *     marks them flushed (→ clearable). It iterates ONLY pending blobs (empty in
 *     steady state), so — unlike the old design — it does NOT re-read/encrypt/HEAD
 *     every already-uploaded blob each round.
 *  3. Evicts to stay under the cache quota.
 */
export async function blobMaintenance(db: DbDriver): Promise<BlobMaintenanceResult> {
  let acquired = 0;
  let flushed = 0;
  const s3peers = listPeers(db).filter((p) => p.enabled && p.kind === "s3" && p.config);

  // 1) Full library: pull referenced blobs it's missing (O(missing); storeFetched
  //    records them pending=0 — they're durable at their source).
  if (isFullBlobNode(db)) {
    for (const hash of referencedHashes(db)) {
      if (await getBlob(hash)) continue;
      if (await resolveBlob(db, hash)) acquired++;
    }
  }

  // 2) Flush this node's pending productions to every attached bucket, then clear
  //    pending. Only iterates the (steady-state-empty) pending worklist.
  if (s3peers.length > 0) {
    for (const { hash } of pendingBlobs(db)) {
      const bytes = await getBlob(hash);
      if (!bytes) continue; // bytes gone (shouldn't happen — pending is protected)
      let ok = true;
      for (const p of s3peers) {
        try {
          await putBucketBlob(JSON.parse(p.config!) as S3Config, hash, bytes); // true | already-there
        } catch {
          ok = false; // bucket unreachable / credentials — retry next round
        }
      }
      if (ok) {
        setPending(db, hash, false);
        flushed++;
      }
    }
  }

  // Keep the local cache under the configured quota (no-op when disabled / under).
  const { evicted } = await evictToQuota(db, getServerConfig(db).blobCacheQuotaBytes);
  return { acquired, flushed, evicted };
}

export interface EvictResult {
  evicted: number;
  freedBytes: number;
}

/** Fraction of the quota to drain down to when eviction triggers, so a node that
 *  crosses the quota doesn't re-evict one blob per tick at the boundary. */
const EVICT_LOW_WATER = 0.8;

/**
 * Auto-evict clearable, unpinned blobs by least-recently-accessed order until the
 * local cache total is at/under the low-water mark. No-op when quotaBytes <= 0
 * (disabled) or the cache is already under quota. Only touches blobs `isClearable`
 * marks safe (durable on the full set) and never a pinned blob — bytes stay
 * re-fetchable, so this is loss-free.
 */
export async function evictToQuota(db: DbDriver, quotaBytes: number): Promise<EvictResult> {
  let evicted = 0;
  let freedBytes = 0;
  if (quotaBytes <= 0) return { evicted, freedBytes };
  reconcileCache(db);
  let blobs = cachedBlobs(db);
  let total = blobs.reduce((s, b) => s + b.size, 0);
  if (total <= quotaBytes) return { evicted, freedBytes };
  // Over quota: verify presence on the anchors NOW so eviction only drops blobs a
  // designated anchor verifiably still holds. When an anchor is offline the verify
  // marks the affected blobs anchored=0 → they fall out of the candidate set →
  // nothing is evicted and the cache stays over quota until the next tick can
  // confirm (loss-free degradation: eviction defers, it never loses data).
  await verifyAnchorPresence(db);
  blobs = cachedBlobs(db);
  const lowWater = Math.floor(quotaBytes * EVICT_LOW_WATER);
  // Oldest first; a null last_access (never touched since record) sorts as oldest.
  const candidates = blobs
    .filter((b) => !b.pinned && isClearable(db, b.hash))
    .sort((a, b) => (a.last_access ?? 0) - (b.last_access ?? 0));
  for (const b of candidates) {
    if (total <= lowWater) break;
    freedBytes += await deleteBlob(b.hash);
    forgetBlob(db, b.hash);
    total -= b.size;
    evicted++;
  }
  return { evicted, freedBytes };
}

export interface ClearResult {
  /** Blobs whose bytes were dropped. */
  cleared: number;
  /** Actual bytes freed on disk. */
  freedBytes: number;
  /** Blobs left in place (sole copy / no anchor / this is a full node). */
  skipped: number;
}

export interface GcResult {
  removed: number;
  freedBytes: number;
}

/**
 * Fold on-disk cache files into the blob_cache ledger so stats/clear/gc also see
 * blobs written before the ledger existed. content_type is unknown for these
 * (left null — serve falls back to the URL suffix).
 */
export function reconcileCache(db: DbDriver): void {
  let names: string[];
  try {
    names = readdirSync(cacheDir());
  } catch {
    return; // no cache dir yet
  }
  const known = new Set(cachedBlobs(db).map((b) => b.hash));
  for (const name of names) {
    if (known.has(name)) continue;
    try {
      const st = statSync(join(cacheDir(), name));
      if (st.isFile()) recordBlob(db, name, st.size, null);
    } catch {
      // file vanished mid-scan — ignore
    }
  }
}

/** Drop the bytes of every locally-cached blob that is safe to clear (durable on
 *  the designated full set). Reference + hash stay in the oplog, re-fetchable. */
export async function clearCache(db: DbDriver): Promise<ClearResult> {
  reconcileCache(db);
  let cleared = 0;
  let freedBytes = 0;
  let skipped = 0;
  for (const b of cachedBlobs(db)) {
    // Pinned blobs are kept regardless of clearability (user opt-out of eviction).
    if (b.pinned || !isClearable(db, b.hash)) {
      skipped++;
      continue;
    }
    freedBytes += await deleteBlob(b.hash);
    forgetBlob(db, b.hash);
    cleared++;
  }
  return { cleared, freedBytes, skipped };
}

/** Drop bytes for blobs no live site_files / doc image still references (true
 *  garbage, distinct from clearable cache). */
export async function gcOrphans(db: DbDriver): Promise<GcResult> {
  reconcileCache(db);
  const referenced = referencedHashes(db);
  let removed = 0;
  let freedBytes = 0;
  for (const b of cachedBlobs(db)) {
    if (referenced.has(b.hash)) continue;
    freedBytes += await deleteBlob(b.hash);
    forgetBlob(db, b.hash);
    removed++;
  }
  return { removed, freedBytes };
}

/** Clear a CHOSEN subset of cached blobs — the per-blob counterpart of
 *  clearCache, for the Settings blob manager. Same safety floor: only a blob that
 *  is unpinned AND isClearable (durable on the designated full set) has its bytes
 *  dropped; everything else is left in place and counted as skipped. */
export async function clearBlobs(db: DbDriver, hashes: string[]): Promise<ClearResult> {
  reconcileCache(db);
  const known = new Map(cachedBlobs(db).map((b) => [b.hash, b]));
  let cleared = 0;
  let freedBytes = 0;
  let skipped = 0;
  for (const hash of new Set(hashes)) {
    const b = known.get(hash);
    if (!b || b.pinned || !isClearable(db, hash)) {
      skipped++;
      continue;
    }
    freedBytes += await deleteBlob(hash);
    forgetBlob(db, hash);
    cleared++;
  }
  return { cleared, freedBytes, skipped };
}

/** Delete a CHOSEN subset of ORPHAN blobs — the per-blob counterpart of gcOrphans.
 *  A hash is removed only when no live site_files / doc image still references it;
 *  any still-referenced (or unknown) hash is skipped, so a blob a document points
 *  at can never be deleted out from under it. */
export async function deleteOrphanBlobs(db: DbDriver, hashes: string[]): Promise<GcResult> {
  reconcileCache(db);
  const known = new Set(cachedBlobs(db).map((b) => b.hash));
  const referenced = referencedHashes(db);
  let removed = 0;
  let freedBytes = 0;
  for (const hash of new Set(hashes)) {
    if (!known.has(hash) || referenced.has(hash)) continue;
    freedBytes += await deleteBlob(hash);
    forgetBlob(db, hash);
    removed++;
  }
  return { removed, freedBytes };
}
