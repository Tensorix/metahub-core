import type { Database } from "bun:sqlite";
import { getNodeId } from "./node.ts";
import { nextHlc, observeHlc } from "./hlc.ts";
import { serializeBlocks } from "./blocks.ts";

// A single field assignment — the unit of replication. `value` is JSON-encoded
// (or null). `dataset`/`row_id`/`col` identify the CRDT register.
export interface Change {
  hlc: string;
  node_id: string;
  dataset: string;
  row_id: string;
  col: string;
  value: string | null;
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
    cols: new Set(["title", "body", "database_id", "parent_id", "created_hlc", "__deleted"]),
  },
  doc_blocks: {
    table: "doc_blocks",
    cols: new Set(["doc_id", "text", "order_key", "__deleted"]),
  },
};

// The `records` dataset is special: these cols hit the `records` table, any
// other col is a property cell (col == property id) stored in record_values.
const RECORD_META = new Set(["database_id", "created_hlc", "__deleted"]);

type SqlValue = string | number | null;

function encodeScalar(val: unknown): SqlValue {
  if (val === null || val === undefined) return null;
  if (typeof val === "boolean") return val ? 1 : 0;
  if (typeof val === "number") return val;
  if (typeof val === "string") return val;
  return JSON.stringify(val);
}

function ensureRow(db: Database, table: string, id: string): void {
  db.query(`INSERT OR IGNORE INTO ${table} (id) VALUES (?)`).run(id);
}

/** A doc is "block-managed" once it has any block row; blocks then own its body. */
function isBlockManaged(db: Database, docId: string): boolean {
  return (
    db.query("SELECT 1 AS x FROM doc_blocks WHERE doc_id = ? LIMIT 1").get(docId) !=
    null
  );
}

/** Rebuild a document's materialized body from its live blocks (ordered). */
function recomputeDocBody(db: Database, docId: string): void {
  const rows = db
    .query(
      "SELECT text FROM doc_blocks WHERE doc_id = ? AND __deleted = 0 ORDER BY order_key, id",
    )
    .all(docId) as { text: string | null }[];
  ensureRow(db, "documents", docId);
  db.query("UPDATE documents SET body = ? WHERE id = ?").run(
    serializeBlocks(rows.map((r) => r.text)),
    docId,
  );
}

function materialize(
  db: Database,
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
    } else if (valueJson === null) {
      db.query(
        "DELETE FROM record_values WHERE record_id = ? AND property_id = ?",
      ).run(rowId, col);
    } else {
      db.query(
        "INSERT INTO record_values (record_id, property_id, value) VALUES (?, ?, ?) ON CONFLICT(record_id, property_id) DO UPDATE SET value = excluded.value",
      ).run(rowId, col, valueJson);
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
export function applyChange(db: Database, c: Change): boolean {
  db.query(
    "INSERT OR IGNORE INTO crdt_changes (hlc, node_id, dataset, row_id, col, value) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(c.hlc, c.node_id, c.dataset, c.row_id, c.col, c.value);

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
  db: Database,
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
  };
  applyChange(db, change);
  return change;
}

/** Apply multiple local field writes to the same row. */
export function emitFields(
  db: Database,
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
export function ingest(db: Database, changes: Change[]): number {
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
export function changesSince(db: Database, since: string): Change[] {
  return db
    .query(
      "SELECT hlc, node_id, dataset, row_id, col, value FROM crdt_changes WHERE hlc > ? ORDER BY hlc",
    )
    .all(since) as Change[];
}

export interface ChangeBatch {
  changes: Change[];
  cursor: number;
}

/**
 * Changes inserted after `seq` (a local rowid), in insertion order, plus the
 * new high-water cursor. Used for replication: insertion order never skips a
 * change even when clocks are skewed.
 */
export function changesAfterSeq(db: Database, seq: number): ChangeBatch {
  const rows = db
    .query(
      "SELECT rowid AS seq, hlc, node_id, dataset, row_id, col, value FROM crdt_changes WHERE rowid > ? ORDER BY rowid",
    )
    .all(seq) as (Change & { seq: number })[];
  const last = rows[rows.length - 1];
  const cursor = last ? last.seq : seq;
  return { changes: rows.map(({ seq: _seq, ...c }) => c), cursor };
}
