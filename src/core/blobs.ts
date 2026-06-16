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
import { type S3Config, getBucketBlob, putBucketBlob } from "./sync/storage.ts";
import { getServerConfig } from "./config.ts";
import {
  cachedBlobs,
  isClearable,
  forgetBlob,
  recordBlob,
  touchBlob,
  referencedHashes,
  announcePresence,
  retractPresence,
  isFullBlobNode,
} from "./blobs-core.ts";

export * from "./blobs-core.ts";

// ---- byte transport: on-demand resolution + full-node maintenance -----------

/** Cache bytes fetched for a reference (by the ref's own hash — which may be a
 *  legacy 64-hex that putBlob's truncation would not reproduce). */
async function storeFetched(db: DbDriver, hash: string, bytes: Uint8Array): Promise<void> {
  await putBlobAt(hash, bytes);
  recordBlob(db, hash, bytes.byteLength, null);
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

export interface BlobMaintenanceResult {
  acquired: number;
  announced: number;
  uploaded: number;
  /** Blobs auto-evicted to stay under the configured cache quota. */
  evicted: number;
}

/**
 * Background blob upkeep, run from the sync tick (throttled). Two jobs:
 *  1. If this node is a full blob library, pull every referenced blob it is
 *     missing (via resolveBlob) and announce the ones it holds, so other devices
 *     can clear their copies.
 *  2. Push every held, referenced blob to each attached bucket (`blobs/<hash>`,
 *     deduped via If-None-Match) so it stays reachable when this node is offline.
 */
export async function blobMaintenance(db: DbDriver): Promise<BlobMaintenanceResult> {
  let acquired = 0;
  let announced = 0;
  let uploaded = 0;
  const refs = referencedHashes(db);
  const full = isFullBlobNode(db);
  const s3peers = listPeers(db).filter((p) => p.enabled && p.kind === "s3" && p.config);

  // Acquisition / announce / bucket-push only apply to a full node or a node with
  // an attached bucket; a plain consumer skips straight to quota eviction.
  if (full || s3peers.length > 0) {
    for (const hash of refs) {
      let bytes = await getBlob(hash);
      if (!bytes && full) {
        bytes = await resolveBlob(db, hash);
        if (bytes) acquired++;
      }
      if (full && bytes && announcePresence(db, hash, bytes.byteLength)) announced++;
      if (bytes) {
        for (const p of s3peers) {
          try {
            if (await putBucketBlob(JSON.parse(p.config!) as S3Config, hash, bytes)) uploaded++;
          } catch {
            // bucket unreachable / credentials — skip, retry next round
          }
        }
      }
    }
  }

  // Keep the local cache under the configured quota (no-op when disabled / under).
  const { evicted } = await evictToQuota(db, getServerConfig(db).blobCacheQuotaBytes);
  return { acquired, announced, uploaded, evicted };
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
  const blobs = cachedBlobs(db);
  let total = blobs.reduce((s, b) => s + b.size, 0);
  if (total <= quotaBytes) return { evicted, freedBytes };
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

/** A device just designated as a full library announces presence for every blob
 *  it already holds, so other devices can immediately clear those copies. No-op
 *  unless this node is currently a full-blob device. Returns the count announced. */
export function announceLocalCache(db: DbDriver): number {
  if (!isFullBlobNode(db)) return 0;
  reconcileCache(db);
  let n = 0;
  for (const b of cachedBlobs(db)) {
    if (announcePresence(db, b.hash, b.size)) n++;
  }
  return n;
}

/** Drop bytes for blobs no live site_files / doc image still references (true
 *  garbage, distinct from clearable cache). Retracts our presence claim too. */
export async function gcOrphans(db: DbDriver): Promise<GcResult> {
  reconcileCache(db);
  const referenced = referencedHashes(db);
  const full = isFullBlobNode(db);
  let removed = 0;
  let freedBytes = 0;
  for (const b of cachedBlobs(db)) {
    if (referenced.has(b.hash)) continue;
    freedBytes += await deleteBlob(b.hash);
    forgetBlob(db, b.hash);
    if (full) retractPresence(db, b.hash);
    removed++;
  }
  return { removed, freedBytes };
}
