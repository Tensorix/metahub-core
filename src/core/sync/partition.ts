// Row-level partition sync primitives for share-scoped rooms (Stage C).
// PORTABLE, driver-only — no node:/bun: imports.
//
// A partition is one share's authorization closure over five datasets:
//   databases   row id ∈ grantedDbIds
//   properties  database_id ∈ grantedDbIds (tombstones included)
//   records     database_id ∈ grantedDbIds (tombstones included — deleting a
//               record does NOT leave the partition; only changing its
//               database_id does)
//   sites       row id = siteId
//   site_files  site_id = siteId
// documents / doc_blocks / meta / node-local tables are excluded.
//
// Membership is computed from the CURRENT-STATE tables (the materialized
// winners — the source of truth), never from the oplog: a row's history may
// span granted and ungranted databases, but only its present home decides
// whether it is in the partition.
//
// The owner keeps a node-local shadow (`room_rows`, see schema.ts) of what it
// last told each room. Per round: entered = M − shadow, left = shadow − M
// (SQL EXCEPT), then shadow := M once the round's payload is delivered.
// Incremental pushes are the oplog filtered by a JOIN against the shadow.

import type { DbDriver } from "../driver.ts";
import { CHANGE_COLS, CHANGE_SELECT, type Change, type ChangeBatch } from "../crdt.ts";

/** The scope of one share's partition. `siteId` is null for pure-data shares. */
export interface PartitionScope {
  grantedDbIds: string[];
  siteId: string | null;
}

/** Identifies one row of one dataset — the unit of membership and eviction. */
export interface RowKey {
  dataset: string;
  row_id: string;
}

export const PARTITION_DATASETS = [
  "databases",
  "properties",
  "records",
  "sites",
  "site_files",
] as const;

/** Oplog columns qualified for JOIN queries (row_id/dataset collide with room_rows). */
const CHANGE_SELECT_Q = CHANGE_COLS.map((c) => "c." + c).join(", ");

// ---- membership -----------------------------------------------------------------

/** The member-set CTE body: `SELECT dataset, row_id` unioned across the five
 *  partition segments, parameterized on the scope. */
function memberSql(scope: PartitionScope): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (scope.grantedDbIds.length > 0) {
    const ph = scope.grantedDbIds.map(() => "?").join(", ");
    parts.push(`SELECT 'databases' AS dataset, id AS row_id FROM databases WHERE id IN (${ph})`);
    params.push(...scope.grantedDbIds);
    parts.push(`SELECT 'properties', id FROM properties WHERE database_id IN (${ph})`);
    params.push(...scope.grantedDbIds);
    parts.push(`SELECT 'records', id FROM records WHERE database_id IN (${ph})`);
    params.push(...scope.grantedDbIds);
  }
  if (scope.siteId) {
    parts.push(`SELECT 'sites', id FROM sites WHERE id = ?`);
    params.push(scope.siteId);
    parts.push(`SELECT 'site_files', id FROM site_files WHERE site_id = ?`);
    params.push(scope.siteId);
  }
  // Empty-scope fallback: name the columns so a bare-subquery wrapper (see
  // computePartitionMembers) doesn't hit "no such column: dataset". Currently a
  // dead branch (a --room share always carries a siteId), kept defensively.
  if (parts.length === 0) parts.push(`SELECT '' AS dataset, '' AS row_id WHERE 0`);
  return { sql: parts.join(" UNION ALL "), params };
}

/** The current member set M of a scope, from the state tables. */
export function computePartitionMembers(db: DbDriver, scope: PartitionScope): RowKey[] {
  const m = memberSql(scope);
  return db
    .query(`SELECT dataset, row_id FROM (${m.sql}) ORDER BY dataset, row_id`)
    .all(...m.params) as RowKey[];
}

/** Membership check for a single row under the CURRENT state — used to
 *  re-judge a room's need_baseline keys (member → send baseline, gone or
 *  out-of-scope → evict). A row that no longer exists is not a member. */
export function isPartitionMember(db: DbDriver, scope: PartitionScope, key: RowKey): boolean {
  switch (key.dataset) {
    case "databases":
      return (
        scope.grantedDbIds.includes(key.row_id) &&
        db.query("SELECT 1 FROM databases WHERE id = ?").get(key.row_id) != null
      );
    case "properties":
    case "records": {
      const row = db
        .query(`SELECT database_id FROM ${key.dataset} WHERE id = ?`)
        .get(key.row_id) as { database_id: string | null } | null;
      return row?.database_id != null && scope.grantedDbIds.includes(row.database_id);
    }
    case "sites":
      return (
        scope.siteId === key.row_id &&
        db.query("SELECT 1 FROM sites WHERE id = ?").get(key.row_id) != null
      );
    case "site_files": {
      if (!scope.siteId) return false;
      const row = db
        .query("SELECT site_id FROM site_files WHERE id = ?")
        .get(key.row_id) as { site_id: string | null } | null;
      return row?.site_id === scope.siteId;
    }
    default:
      return false;
  }
}

// ---- shadow diff ----------------------------------------------------------------

export interface PartitionDiff {
  /** In M but not yet in the shadow — need a full-row baseline. */
  entered: RowKey[];
  /** In the shadow but no longer in M — need an evict. */
  left: RowKey[];
}

/** entered/left between the current member set and the peer's shadow.
 *  READ-ONLY: the caller applies the diff (applyPartitionDiff) only after the
 *  payload actually reached the room, so a lost response is re-prepared
 *  identically on retry. */
export function partitionDiff(db: DbDriver, peerKey: string, scope: PartitionScope): PartitionDiff {
  const m = memberSql(scope);
  const entered = db
    .query(
      `WITH m(dataset, row_id) AS (${m.sql})
       SELECT dataset, row_id FROM m
       EXCEPT SELECT dataset, row_id FROM room_rows WHERE peer_key = ?`,
    )
    .all(...m.params, peerKey) as RowKey[];
  const left = db
    .query(
      `WITH m(dataset, row_id) AS (${m.sql})
       SELECT dataset, row_id FROM room_rows WHERE peer_key = ?
       EXCEPT SELECT dataset, row_id FROM m`,
    )
    .all(...m.params, peerKey) as RowKey[];
  return { entered, left };
}

/** Commit a delivered diff into the shadow: shipped entered rows join, left
 *  rows leave. Idempotent (INSERT OR IGNORE / blind DELETE). */
export function applyPartitionDiff(db: DbDriver, peerKey: string, diff: PartitionDiff): void {
  const del = db.query("DELETE FROM room_rows WHERE peer_key = ? AND dataset = ? AND row_id = ?");
  for (const k of diff.left) del.run(peerKey, k.dataset, k.row_id);
  const ins = db.query(
    "INSERT OR IGNORE INTO room_rows (peer_key, dataset, row_id) VALUES (?, ?, ?)",
  );
  for (const k of diff.entered) ins.run(peerKey, k.dataset, k.row_id);
}

/** Replace the peer's whole shadow (digest-mismatch full reconcile). */
export function resetPartitionShadow(db: DbDriver, peerKey: string, members: RowKey[]): void {
  db.query("DELETE FROM room_rows WHERE peer_key = ?").run(peerKey);
  applyPartitionDiff(db, peerKey, { entered: members, left: [] });
}

// ---- partition-filtered oplog scan ----------------------------------------------

export interface PartitionChangesOpts {
  /** Max rows to return — pagination, same semantics as changesAfterSeq. */
  limit?: number;
  /** Skip changes authored under this guest base node id (exact or
   *  `<base>-<sub>`): the room authored those itself, echoing them back is
   *  pure noise (the room's oplog UNIQUE would dedup, but a room that already
   *  GC'd them would re-insert). The cursor still advances over skipped rows. */
  excludeGuestBase?: string;
}

/**
 * changesAfterSeq filtered to the peer's shadow: oplog changes with seq > `seq`
 * whose (dataset,row_id) is in room_rows for `peerKey`, in insertion order.
 * Cursor semantics mirror crdt.ts changesAfterSeq exactly: with `limit` the
 * cursor stops at the last RETURNED row so the next pull resumes there; when
 * the scan is exhausted it jumps to the table's high-water seq so filtered-out
 * tails are skipped once, not rescanned every round.
 */
export function partitionChangesAfterSeq(
  db: DbDriver,
  seq: number,
  peerKey: string,
  opts: PartitionChangesOpts = {},
): ChangeBatch {
  const clauses = ["c.seq > ?"];
  const params: (string | number)[] = [peerKey, seq];
  if (opts.excludeGuestBase != null) {
    clauses.push("NOT (c.node_id = ? OR c.node_id LIKE ? || '-%')");
    params.push(opts.excludeGuestBase, opts.excludeGuestBase);
  }
  const limitSql = opts.limit != null && opts.limit > 0 ? ` LIMIT ${Math.floor(opts.limit)}` : "";
  const rows = db
    .query(
      `SELECT c.seq AS seq, ${CHANGE_SELECT_Q} FROM crdt_changes c
       JOIN room_rows r ON r.peer_key = ? AND r.dataset = c.dataset AND r.row_id = c.row_id
       WHERE ${clauses.join(" AND ")} ORDER BY c.seq${limitSql}`,
    )
    .all(...params) as (Change & { seq: number })[];

  const exhausted = opts.limit == null || opts.limit <= 0 || rows.length < opts.limit;
  let cursor: number;
  if (exhausted) {
    const top = db.query("SELECT MAX(seq) AS m FROM crdt_changes").get() as { m: number | null };
    cursor = Math.max(seq, top.m ?? seq);
  } else {
    cursor = rows[rows.length - 1]!.seq;
  }
  return { changes: rows.map(({ seq: _seq, ...c }) => c), cursor };
}

// ---- baselines & winners ----------------------------------------------------------

/** Current winners (max-HLC change per register) of ONE row — the baseline
 *  shipped when a row enters the partition. Mirrors storage.ts's
 *  winnersSnapshot NOT EXISTS shape, scoped to a single (dataset,row_id). */
export function rowBaseline(db: DbDriver, dataset: string, rowId: string): Change[] {
  return db
    .query(
      `SELECT ${CHANGE_SELECT} FROM crdt_changes c
       WHERE c.dataset = ? AND c.row_id = ? AND NOT EXISTS (
         SELECT 1 FROM crdt_changes k
         WHERE k.dataset = c.dataset AND k.row_id = c.row_id AND k.col = c.col AND k.hlc > c.hlc
       )`,
    )
    .all(dataset, rowId) as Change[];
}

/** Winners of every register whose row is currently in the partition —
 *  the owner side of the digest, and the payload of a full reconcile. */
export function partitionWinners(db: DbDriver, scope: PartitionScope): Change[] {
  const m = memberSql(scope);
  return db
    .query(
      `WITH m(dataset, row_id) AS (${m.sql})
       SELECT ${CHANGE_SELECT_Q} FROM crdt_changes c
       JOIN m ON m.dataset = c.dataset AND m.row_id = c.row_id
       WHERE NOT EXISTS (
         SELECT 1 FROM crdt_changes k
         WHERE k.dataset = c.dataset AND k.row_id = c.row_id AND k.col = c.col AND k.hlc > c.hlc
       )`,
    )
    .all(...m.params) as Change[];
}

/** Winners of every register in the whole oplog — the room side of the digest
 *  (a room's entire oplog IS its partition plus its guest ops). */
export function allWinners(db: DbDriver): Change[] {
  return db
    .query(
      `SELECT ${CHANGE_SELECT} FROM crdt_changes c
       WHERE NOT EXISTS (
         SELECT 1 FROM crdt_changes k
         WHERE k.dataset = c.dataset AND k.row_id = c.row_id AND k.col = c.col AND k.hlc > c.hlc
       )`,
    )
    .all() as Change[];
}

// ---- digest ------------------------------------------------------------------------

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

/**
 * Order-insensitive anti-entropy digest over a winner set: the winners'
 * (dataset, row_id, col, hlc) tuples are canonically sorted, then FNV-1a-64
 * hashed as one stream. The hlc pins the winning change exactly (the oplog's
 * (dataset,row_id,col,hlc) UNIQUE means equal tuples imply equal values), so
 * two ends holding the same winners produce the same digest — BOTH ends must
 * use this same function.
 */
export function winnersDigest(rows: Pick<Change, "dataset" | "row_id" | "col" | "hlc">[]): string {
  const keys = rows.map((r) => `${r.dataset} ${r.row_id} ${r.col} ${r.hlc}`).sort();
  let h = FNV_OFFSET;
  for (const key of keys) {
    for (let i = 0; i < key.length; i++) {
      h = ((h ^ BigInt(key.charCodeAt(i))) * FNV_PRIME) & FNV_MASK;
    }
    h = ((h ^ 0x1en) * FNV_PRIME) & FNV_MASK; // record separator
  }
  return h.toString(16).padStart(16, "0");
}

/** The owner-side digest of a scope (winners restricted to current members). */
export function partitionDigest(db: DbDriver, scope: PartitionScope): string {
  return winnersDigest(partitionWinners(db, scope));
}
