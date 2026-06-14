import type { DbDriver } from "./driver.ts";
import { getNodeId } from "./node.ts";
import { nextHlc, observeHlc } from "./hlc.ts";
import { serializeDocBlocks } from "./blocks.ts";
import { randomSuffix } from "./ids.ts";
import type { ColumnsOf } from "./sqlcols.ts";

// A single field assignment — the unit of replication. `value` is JSON-encoded
// (or null). `dataset`/`row_id`/`col` identify the CRDT register. `txn` groups
// the changes of one logical mutation (one save / one API call) so history can
// render them as a single revision; it replicates but plays no role in LWW.
export interface Change {
  hlc: string;
  node_id: string;
  dataset: string;
  row_id: string;
  col: string;
  value: string | null;
  txn?: string | null;
}

/** Oplog SELECT list, locked to the Change interface (also reused by history). */
export const CHANGE_COLS = ["hlc", "node_id", "dataset", "row_id", "col", "value", "txn"] as const;
const _changeCols: ColumnsOf<Change, typeof CHANGE_COLS> = CHANGE_COLS;
export const CHANGE_SELECT = CHANGE_COLS.join(", ");

// Current change group. Core mutations are synchronous and single-threaded, so
// a module-level slot (set around each public mutator via grouped()) is enough.
let currentTxn: string | null = null;

/**
 * Run `fn` with all emits stamped with one shared txn id. Nested calls keep the
 * outermost group (a revert that calls updateDocument is ONE revision). `label`
 * prefixes the id ("repair:", "revert:") so history can classify the source.
 */
export function withChangeGroup<T>(label: string | null, fn: () => T): T {
  if (currentTxn !== null) return fn();
  currentTxn = (label ? label + ":" : "") + randomSuffix(8);
  try {
    return fn();
  } finally {
    currentTxn = null;
  }
}

/** Wrap a mutator so its body runs inside one change group. */
export function grouped<A extends unknown[], R>(
  fn: (...args: A) => R,
  label: string | null = null,
): (...args: A) => R {
  return (...args) => withChangeGroup(label, () => fn(...args));
}

// Domain tables addressable by id, with their write-allowed columns. `col` is
// interpolated into SQL, so it MUST be validated against these allowlists
// (changes can arrive from untrusted sync peers).
const DOMAIN: Record<string, { table: string; cols: Set<string> }> = {
  databases: {
    table: "databases",
    cols: new Set(["name", "icon", "created_hlc", "__deleted"]),
  },
  properties: {
    table: "properties",
    cols: new Set(["database_id", "name", "type", "config", "position", "__deleted"]),
  },
  documents: {
    table: "documents",
    cols: new Set(["title", "body", "database_id", "parent_id", "created_hlc", "order_key", "__deleted"]),
  },
  doc_blocks: {
    table: "doc_blocks",
    cols: new Set(["doc_id", "text", "order_key", "blank_after", "__deleted"]),
  },
  sites: {
    table: "sites",
    cols: new Set(["name", "title", "created_hlc", "__deleted"]),
  },
  site_files: {
    table: "site_files",
    cols: new Set([
      "site_id",
      "path",
      "content_type",
      "encoding",
      "content",
      "created_hlc",
      "__deleted",
    ]),
  },
};

// The `records` dataset is special: these cols hit the `records` table, any
// other col is a property cell (col == property id) folded into records.data JSON.
const RECORD_META = new Set(["database_id", "created_hlc", "order_key", "__deleted"]);

type SqlValue = string | number | null;

function encodeScalar(val: unknown): SqlValue {
  if (val === null || val === undefined) return null;
  if (typeof val === "boolean") return val ? 1 : 0;
  if (typeof val === "number") return val;
  if (typeof val === "string") return val;
  return JSON.stringify(val);
}

function ensureRow(db: DbDriver, table: string, id: string): void {
  db.query(`INSERT OR IGNORE INTO ${table} (id) VALUES (?)`).run(id);
}

/** A doc is "block-managed" once it has any block row; blocks then own its body. */
function isBlockManaged(db: DbDriver, docId: string): boolean {
  return (
    db.query("SELECT 1 AS x FROM doc_blocks WHERE doc_id = ? LIMIT 1").get(docId) !=
    null
  );
}

/** Rebuild a document's materialized body from its live blocks (ordered). */
function recomputeDocBody(db: DbDriver, docId: string): void {
  const rows = db
    .query(
      "SELECT text, blank_after FROM doc_blocks WHERE doc_id = ? AND __deleted = 0 ORDER BY order_key, id",
    )
    .all(docId) as { text: string | null; blank_after: number | null }[];
  ensureRow(db, "documents", docId);
  db.query("UPDATE documents SET body = ? WHERE id = ?").run(
    serializeDocBlocks(rows.map((r) => ({ text: r.text, blankAfter: r.blank_after ?? 0 }))),
    docId,
  );
}

function materialize(
  db: DbDriver,
  dataset: string,
  rowId: string,
  col: string,
  valueJson: string | null,
): void {
  if (dataset === "records") {
    if (RECORD_META.has(col)) {
      ensureRow(db, "records", rowId);
      const v = valueJson === null ? null : JSON.parse(valueJson);
      db.query(`UPDATE records SET "${col}" = ? WHERE id = ?`).run(
        encodeScalar(v),
        rowId,
      );
    } else {
      // Property cell -> a key in the record's JSON `data`. ensureRow first:
      // a cell write can arrive before database_id (out-of-order sync).
      ensureRow(db, "records", rowId);
      if (valueJson === null) {
        db.query(
          `UPDATE records SET data = json_remove(data, '$."' || ? || '"') WHERE id = ?`,
        ).run(col, rowId);
      } else {
        // json(?) embeds the value with its real JSON type (number/array/object),
        // not as a quoted string.
        db.query(
          `UPDATE records SET data = json_set(coalesce(data, '{}'), '$."' || ? || '"', json(?)) WHERE id = ?`,
        ).run(col, valueJson, rowId);
      }
    }
    return;
  }

  const d = DOMAIN[dataset];
  if (!d || !d.cols.has(col)) return; // unknown dataset/column -> ignore (forward-compat)

  // Legacy documents.body register is ignored once the doc is block-managed:
  // blocks are authoritative and recompute the body cache themselves.
  if (dataset === "documents" && col === "body" && isBlockManaged(db, rowId)) return;

  ensureRow(db, d.table, rowId);
  const v = valueJson === null ? null : JSON.parse(valueJson);
  db.query(`UPDATE ${d.table} SET "${col}" = ? WHERE id = ?`).run(
    encodeScalar(v),
    rowId,
  );

  // A block change re-derives its document's body cache. doc_id may not have
  // materialized yet (out-of-order sync) — the later doc_id write recomputes.
  if (dataset === "doc_blocks") {
    const blk = db
      .query("SELECT doc_id FROM doc_blocks WHERE id = ?")
      .get(rowId) as { doc_id: string | null } | null;
    if (blk?.doc_id) recomputeDocBody(db, blk.doc_id);
  }
}

/**
 * Record a change in the oplog (idempotent) and, if it is the latest write for
 * its register, materialize it. Order-independent: convergence holds regardless
 * of the order changes are applied, because the winner is recomputed as the max
 * HLC over the full oplog for that register.
 */
export function applyChange(db: DbDriver, c: Change): boolean {
  db.query(
    "INSERT OR IGNORE INTO crdt_changes (hlc, node_id, dataset, row_id, col, value, txn) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(c.hlc, c.node_id, c.dataset, c.row_id, c.col, c.value, c.txn ?? null);

  const cur = db
    .query(
      "SELECT MAX(hlc) AS h FROM crdt_changes WHERE dataset = ? AND row_id = ? AND col = ?",
    )
    .get(c.dataset, c.row_id, c.col) as { h: string | null };

  if (cur.h !== c.hlc) return false; // a newer write already wins
  materialize(db, c.dataset, c.row_id, c.col, c.value);
  return true;
}

/** Apply a local write: assign a fresh HLC, append to oplog, materialize. */
export function emit(
  db: DbDriver,
  dataset: string,
  rowId: string,
  col: string,
  value: unknown,
): Change {
  const node = getNodeId(db);
  const change: Change = {
    hlc: nextHlc(db, node),
    node_id: node,
    dataset,
    row_id: rowId,
    col,
    value: value === undefined ? null : JSON.stringify(value),
    txn: currentTxn,
  };
  applyChange(db, change);
  return change;
}

/** Apply multiple local field writes to the same row. */
export function emitFields(
  db: DbDriver,
  dataset: string,
  rowId: string,
  fields: Record<string, unknown>,
): Change[] {
  const out: Change[] = [];
  for (const [col, value] of Object.entries(fields)) {
    out.push(emit(db, dataset, rowId, col, value));
  }
  return out;
}

/** Apply remote changes from a sync peer (advances clock, then merges). */
export function ingest(db: DbDriver, changes: Change[]): number {
  const node = getNodeId(db);
  let applied = 0;
  const tx = db.transaction((cs: Change[]) => {
    for (const c of cs) {
      observeHlc(db, node, c.hlc);
      if (applyChange(db, c)) applied++;
    }
  });
  tx(changes);
  return applied;
}

/** All oplog changes with HLC strictly greater than `since` (test/debug helper). */
export function changesSince(db: DbDriver, since: string): Change[] {
  return db
    .query(`SELECT ${CHANGE_SELECT} FROM crdt_changes WHERE hlc > ? ORDER BY hlc`)
    .all(since) as Change[];
}

export interface ChangeBatch {
  changes: Change[];
  cursor: number;
}

export interface ChangesAfterOpts {
  /** Max rows to return — pagination for large pulls (initial hydration). */
  limit?: number;
  /** Datasets to omit (partial replicas, e.g. a phone skipping site_files). */
  excludeDatasets?: string[];
  /**
   * Return only changes this node produced itself. Storage-sync (see
   * sync/storage.ts) publishes each node's own ops under its own bucket prefix,
   * so it must not re-upload ops it merely ingested from peers. The cursor still
   * advances over the filtered-out rows (high-water on exhaustion), so ingested
   * ops are skipped once, not rescanned every round.
   */
  onlyNode?: string;
}

/**
 * Changes inserted after `seq` (a local rowid), in insertion order, plus the
 * new high-water cursor. Used for replication: insertion order never skips a
 * change even when clocks are skewed.
 *
 * With `limit`, the cursor stops at the last returned row so the next pull
 * resumes there; when the scan is exhausted (fewer rows than the limit, or no
 * limit) the cursor jumps to the table's high-water rowid so excluded-dataset
 * tails aren't rescanned every round.
 */
export function changesAfterSeq(
  db: DbDriver,
  seq: number,
  opts: ChangesAfterOpts = {},
): ChangeBatch {
  const exclude = opts.excludeDatasets ?? [];
  const clauses = ["rowid > ?"];
  const params: (string | number)[] = [seq];
  if (exclude.length) {
    clauses.push(`dataset NOT IN (${exclude.map(() => "?").join(", ")})`);
    params.push(...exclude);
  }
  if (opts.onlyNode != null) {
    clauses.push("node_id = ?");
    params.push(opts.onlyNode);
  }
  const where = clauses.join(" AND ");
  const limitSql = opts.limit != null && opts.limit > 0 ? ` LIMIT ${Math.floor(opts.limit)}` : "";
  const rows = db
    .query(
      `SELECT rowid AS seq, ${CHANGE_SELECT} FROM crdt_changes WHERE ${where} ORDER BY rowid${limitSql}`,
    )
    .all(...params) as (Change & { seq: number })[];

  const exhausted = opts.limit == null || opts.limit <= 0 || rows.length < opts.limit;
  let cursor: number;
  if (exhausted) {
    // High-water on exhaustion. crdt_changes.seq is an AUTOINCREMENT PK (rowid
    // alias), stable across VACUUM and never reused, so MAX(rowid) no longer
    // drops below a cursor a client already holds — the Math.max is now just a
    // defensive floor (was load-bearing before the seq migration, see
    // migrateCrdtChangesSeq).
    const top = db.query("SELECT MAX(rowid) AS m FROM crdt_changes").get() as { m: number | null };
    cursor = Math.max(seq, top.m ?? seq);
  } else {
    cursor = rows[rows.length - 1]!.seq;
  }
  return { changes: rows.map(({ seq: _seq, ...c }) => c), cursor };
}
