import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { formatHlc } from "./hlc.ts";
import { cacheDir } from "./paths.ts";
import { MhError } from "./errors.ts";

// Retention-window oplog compaction. Inside the window history is kept intact;
// older than the window every register collapses to its as-of-cutoff winner, so
// the materialized head state is byte-identical before and after.
//
// Why this is safe under sync (each invariant is load-bearing):
//   1. Only superseded writes are deleted — every removed row is beaten by a
//      surviving row of the same register with hlc <= cutoff, so LWW converges
//      to the same state on any peer that has (or later receives) the survivors.
//   2. Tombstone winners survive, so deleted rows can never resurrect on a peer.
//   3. The global MAX(rowid) row is never deleted. crdt_changes.seq is now an
//      AUTOINCREMENT PK, so ids are never reused or renumbered (even by the
//      VACUUM below) — this guard is defensive, kept because the WHERE clause is
//      cheap and documents intent. (Before the seq migration the implicit rowid
//      WAS reusable/renumberable, which silently stranded peers' cursors — see
//      migrateCrdtChangesSeq in schema-init.ts.)
//   4. Compaction is local-only (no emit, nothing replicates): every node prunes
//      its own disk on its own schedule.

export interface CompactResult {
  /** HLC cutoff actually used — history at or before this collapses to a baseline. */
  cutoff: string;
  deleted_changes: number;
  kept_changes: number;
  blobs_deleted: number;
  blob_bytes_freed: number;
  db_bytes_before: number;
  db_bytes_after: number;
  dry_run: boolean;
}

export interface CompactOptions {
  /** Keep full history for this many days; 0 keeps only the head state. */
  keepDays: number;
  /** Report what would be removed without changing anything. */
  dryRun?: boolean;
  /** Run VACUUM afterwards to return the freed pages to the filesystem. */
  vacuum?: boolean;
  /** Test hook: "now" in epoch millis. */
  now?: number;
}

function dbBytes(db: Database): number {
  const pc = db.query("PRAGMA page_count").get() as { page_count: number };
  const ps = db.query("PRAGMA page_size").get() as { page_size: number };
  return pc.page_count * ps.page_size;
}

/** WHERE clause selecting the compactable rows (superseded within the window). */
const COMPACTABLE = `
  hlc <= ?1
  AND rowid <> (SELECT MAX(rowid) FROM crdt_changes)
  AND EXISTS (
    SELECT 1 FROM crdt_changes k
    WHERE k.dataset = crdt_changes.dataset
      AND k.row_id  = crdt_changes.row_id
      AND k.col     = crdt_changes.col
      AND k.hlc     > crdt_changes.hlc
      AND k.hlc    <= ?1
  )`;

export function compactOplog(db: Database, opts: CompactOptions): CompactResult {
  if (!Number.isFinite(opts.keepDays) || opts.keepDays < 0)
    throw new MhError("invalid_input", "keepDays must be a non-negative number");
  const now = opts.now ?? Date.now();
  // counter 0xffff + node "~" sort above every real HLC in the same millisecond,
  // so the whole millisecond falls inside the window edge.
  const cutoff = formatHlc({
    millis: Math.max(0, now - opts.keepDays * 86_400_000),
    counter: 0xffff,
    node: "~",
  });

  const bytesBefore = dbBytes(db);
  const dryRun = opts.dryRun === true;

  let deleted: number;
  if (dryRun) {
    const row = db
      .query(`SELECT COUNT(*) AS n FROM crdt_changes WHERE ${COMPACTABLE}`)
      .get(cutoff) as { n: number };
    deleted = row.n;
  } else {
    deleted = db.query(`DELETE FROM crdt_changes WHERE ${COMPACTABLE}`).run(cutoff).changes;
  }
  const kept = (db.query("SELECT COUNT(*) AS n FROM crdt_changes").get() as { n: number }).n -
    (dryRun ? deleted : 0);

  const blobs = gcBlobs(db, { dryRun });

  let bytesAfter = bytesBefore;
  if (!dryRun && opts.vacuum !== false) {
    try {
      db.exec("VACUUM");
    } catch {
      // VACUUM needs temp space roughly the size of the db; if it fails the
      // deletions still hold and the pages are reused by future writes.
    }
    bytesAfter = dbBytes(db);
  }

  return {
    cutoff,
    deleted_changes: deleted,
    kept_changes: kept,
    blobs_deleted: blobs.deleted,
    blob_bytes_freed: blobs.bytes,
    db_bytes_before: bytesBefore,
    db_bytes_after: bytesAfter,
    dry_run: dryRun,
  };
}

/**
 * Delete cache blobs no longer referenced by any remaining oplog value or
 * materialized site file. Conservative: only files named like a sha256 hash
 * are candidates; anything else in the cache dir is left alone.
 */
export function gcBlobs(
  db: Database,
  opts: { dryRun?: boolean } = {},
): { deleted: number; bytes: number } {
  const dir = cacheDir();
  if (!existsSync(dir)) return { deleted: 0, bytes: 0 };

  const referenced = new Set<string>();
  const collect = (rows: { v: string | null }[]) => {
    for (const r of rows) {
      if (r.v == null) continue;
      try {
        const parsed: unknown = JSON.parse(r.v);
        if (typeof parsed === "string") referenced.add(parsed);
      } catch {
        referenced.add(r.v); // materialized values are raw strings
      }
    }
  };
  collect(
    db
      .query(
        "SELECT DISTINCT value AS v FROM crdt_changes WHERE dataset = 'site_files' AND col = 'content'",
      )
      .all() as { v: string | null }[],
  );
  collect(
    db.query("SELECT DISTINCT content AS v FROM site_files").all() as { v: string | null }[],
  );

  let deleted = 0;
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue;
    if (referenced.has(name)) continue;
    const path = join(dir, name);
    try {
      bytes += statSync(path).size;
      if (!opts.dryRun) unlinkSync(path);
      deleted++;
    } catch {
      // raced with another process — skip
    }
  }
  return { deleted, bytes };
}

/** Dry-run quick stats for doctor: total oplog rows and how many compaction
 *  with the given window would remove. */
export function compactEstimate(
  db: Database,
  keepDays: number,
  now = Date.now(),
): { total_changes: number; compactable_changes: number; db_bytes: number } {
  const cutoff = formatHlc({
    millis: Math.max(0, now - keepDays * 86_400_000),
    counter: 0xffff,
    node: "~",
  });
  const total = (db.query("SELECT COUNT(*) AS n FROM crdt_changes").get() as { n: number }).n;
  const compactable = (
    db.query(`SELECT COUNT(*) AS n FROM crdt_changes WHERE ${COMPACTABLE}`).get(cutoff) as {
      n: number;
    }
  ).n;
  return { total_changes: total, compactable_changes: compactable, db_bytes: dbBytes(db) };
}
