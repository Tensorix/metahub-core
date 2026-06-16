// Node-only half of the blob ledger: the pieces that touch the on-disk cache
// (delete bytes, reconcile legacy files) or the network (resolve missing bytes —
// added with the transport layer). Re-exports blobs-core.ts so server-side
// callers import everything from here.

import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import type { DbDriver } from "./driver.ts";
import { cacheDir } from "./paths.ts";
import { deleteBlob } from "./cache.ts";
import {
  cachedBlobs,
  isClearable,
  forgetBlob,
  recordBlob,
  referencedHashes,
  announcePresence,
  retractPresence,
  isFullBlobNode,
} from "./blobs-core.ts";

export * from "./blobs-core.ts";

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
    if (!isClearable(db, b.hash)) {
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
    announcePresence(db, b.hash, b.size);
    n++;
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
