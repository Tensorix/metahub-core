// Runtime-agnostic schema bootstrap: everything needed to bring a metahub
// database to the current schema, typed against the portable driver surface so
// it runs both on Bun (bun:sqlite) and in a browser worker (sqlite-wasm).
// Opening the on-disk database lives in db.ts, which composes these.

import type { DbDriver } from "./driver.ts";
import { CORE_SCHEMA, FTS_SCHEMA } from "./schema.ts";
import { backfillRecordOrderKeys } from "./records.ts";
import { backfillDocumentOrderKeys } from "./documents.ts";

export function runSchema(db: DbDriver): void {
  db.exec(CORE_SCHEMA);
  try {
    db.exec(FTS_SCHEMA);
  } catch {
    // FTS5 unavailable; search will fall back to LIKE.
  }
}

export function ftsAvailable(db: DbDriver): boolean {
  const row = db
    .query("SELECT 1 AS ok FROM sqlite_master WHERE name = 'search_fts'")
    .get() as { ok: number } | null;
  return row != null;
}

function hasColumn(db: DbDriver, table: string, column: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function tableExists(db: DbDriver, table: string): boolean {
  return (
    db
      .query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) != null
  );
}

/**
 * Migrate legacy EAV records (record_values: one row per cell) to the JSON
 * layout (records.data: one row per record). Idempotent — keyed off schema
 * shape, no version flag. A no-op for fresh databases.
 */
export function migrateRecords(db: DbDriver): void {
  if (!hasColumn(db, "records", "data"))
    db.exec("ALTER TABLE records ADD COLUMN data TEXT NOT NULL DEFAULT '{}'");
  if (!hasColumn(db, "records", "order_key"))
    db.exec("ALTER TABLE records ADD COLUMN order_key TEXT");

  if (!tableExists(db, "record_values")) return;

  const tx = db.transaction(() => {
    // Fold each record's cells into a JSON object keyed by property id.
    db.exec(`
      UPDATE records SET data = coalesce((
        SELECT json_group_object(rv.property_id, json(rv.value))
        FROM record_values rv WHERE rv.record_id = records.id
      ), '{}')
      WHERE id IN (SELECT DISTINCT record_id FROM record_values);
    `);
    db.exec("DROP TABLE record_values");
    backfillRecordOrderKeys(db);
  });
  tx();

  backfillRecordOrderKeys(db);
}

/**
 * Add the peer-pairing columns to a legacy `peers` table (token/label/node_id/
 * enabled/last_sync_at/last_success_at/last_status/last_error). Idempotent —
 * guarded per column, never drops the table so existing replication cursors survive.
 */
export function migratePeers(db: DbDriver): void {
  const add: [string, string][] = [
    ["token", "TEXT"],
    ["label", "TEXT"],
    ["node_id", "TEXT"],
    ["enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["last_sync_at", "INTEGER"],
    ["last_success_at", "INTEGER"],
    ["last_status", "TEXT"],
    ["last_error", "TEXT"],
    // Storage-sync (sync/storage.ts): kind selects the transport, config holds
    // an 's3' peer's bucket settings. Legacy rows default to 'http', unchanged.
    ["kind", "TEXT NOT NULL DEFAULT 'http'"],
    ["config", "TEXT"],
  ];
  for (const [col, decl] of add) {
    if (!hasColumn(db, "peers", col)) db.exec(`ALTER TABLE peers ADD COLUMN ${col} ${decl}`);
  }
  db.exec(
    "UPDATE peers SET last_success_at = last_sync_at " +
      "WHERE last_success_at IS NULL AND last_status = 'ok' AND last_sync_at IS NOT NULL",
  );
}

/**
 * Add the `blank_after` column to a legacy `doc_blocks` table. Idempotent —
 * guarded by hasColumn; existing blocks default to 0 (canonical single-blank-line
 * separators), so the migration never changes an existing document's body.
 */
export function migrateDocBlocks(db: DbDriver): void {
  if (!hasColumn(db, "doc_blocks", "blank_after"))
    db.exec("ALTER TABLE doc_blocks ADD COLUMN blank_after INTEGER NOT NULL DEFAULT 0");
}

/**
 * Bring a legacy `blob_cache` to the current shape and retire the old synced
 * `blob_presence` table. Idempotent (guarded by hasColumn / IF EXISTS).
 *  - `pinned`: node-local, never auto-evicted/cleared.
 *  - `pending`: bytes produced here, not yet flushed to a durable anchor. Existing
 *    rows can't be classified produced-vs-acquired, so default to 1 (protected);
 *    the next online flush sets already-in-bucket blobs back to 0, so it self-heals
 *    and is loss-free. See blobs.ts.
 *  - `blob_presence` (was synced) is dropped: clearing is now decided locally from
 *    `pending`. Leftover presence oplog changes are ignored (forward-compat).
 */
export function migrateBlobCache(db: DbDriver): void {
  if (!hasColumn(db, "blob_cache", "pinned"))
    db.exec("ALTER TABLE blob_cache ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  if (!hasColumn(db, "blob_cache", "pending"))
    db.exec("ALTER TABLE blob_cache ADD COLUMN pending INTEGER NOT NULL DEFAULT 1");
  db.exec("DROP TABLE IF EXISTS blob_presence");
}

/**
 * Add the `order_key` column to a legacy `documents` table and backfill it.
 * Idempotent — guarded by hasColumn; backfill only touches rows with a NULL key,
 * assigning per-parent fractional indices in current created_hlc order, so the
 * displayed document order is unchanged until the user first drags something.
 */
export function migrateDocuments(db: DbDriver): void {
  if (!hasColumn(db, "documents", "order_key"))
    db.exec("ALTER TABLE documents ADD COLUMN order_key TEXT");
  backfillDocumentOrderKeys(db);
}

/**
 * Add the `txn` change-group column to a legacy `crdt_changes` table.
 * Idempotent — guarded by hasColumn; existing rows stay NULL (history falls
 * back to time-gap clustering for them).
 */
export function migrateOplog(db: DbDriver): void {
  if (!hasColumn(db, "crdt_changes", "txn"))
    db.exec("ALTER TABLE crdt_changes ADD COLUMN txn TEXT");
}

/**
 * Rebuild a legacy `crdt_changes` (composite PRIMARY KEY, implicit rowid) into
 * the current shape with an explicit `seq INTEGER PRIMARY KEY AUTOINCREMENT`.
 *
 * Why: replication push/pull cursors are crdt_changes rowids. The legacy table
 * has no declared INTEGER PRIMARY KEY, so a `VACUUM` (run by `mh` compaction)
 * renumbers its rowids 1..N; a peer's stored cursor then sits above the new
 * MAX(rowid) and `changesAfterSeq`'s "never regress" floor pins it there,
 * silently never pushing/pulling the writes below it. The declared `seq` is
 * stable across VACUUM and never reused, closing the hole.
 *
 * Idempotent — guarded by the `seq` column. Old rowids are copied verbatim into
 * seq so any *uncorrupted* cursor stays meaningful; then push/pull cursors are
 * reset to 0 because we cannot tell which were already stranded by a past
 * VACUUM, and a from-scratch re-sync is safe (INSERT OR IGNORE / ingest dedup)
 * — a one-time catch-up on first sync after upgrade. storage_cursors are
 * object-key based, never rowids, so they are left intact.
 */
export function migrateCrdtChangesSeq(db: DbDriver): void {
  if (hasColumn(db, "crdt_changes", "seq")) return;
  const tx = db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS crdt_changes_new;
      CREATE TABLE crdt_changes_new (
        seq     INTEGER PRIMARY KEY AUTOINCREMENT,
        hlc     TEXT NOT NULL,
        node_id TEXT NOT NULL,
        dataset TEXT NOT NULL,
        row_id  TEXT NOT NULL,
        col     TEXT NOT NULL,
        value   TEXT,
        txn     TEXT,
        UNIQUE (dataset, row_id, col, hlc)
      );
      INSERT INTO crdt_changes_new (seq, hlc, node_id, dataset, row_id, col, value, txn)
        SELECT rowid, hlc, node_id, dataset, row_id, col, value, txn
        FROM crdt_changes ORDER BY rowid;
      DROP TABLE crdt_changes;
      ALTER TABLE crdt_changes_new RENAME TO crdt_changes;
      CREATE INDEX IF NOT EXISTS idx_changes_hlc ON crdt_changes(hlc);
      CREATE INDEX IF NOT EXISTS idx_changes_docref ON crdt_changes(value)
        WHERE dataset = 'doc_blocks' AND col = 'doc_id';
    `);
    if (tableExists(db, "peers")) db.exec("UPDATE peers SET push_cursor = 0, pull_cursor = 0");
  });
  tx();
}

/** Bring a freshly opened (or legacy) database to the current schema. */
export function initSchema(db: DbDriver): void {
  runSchema(db);
  migrateOplog(db);
  migrateCrdtChangesSeq(db);
  migrateRecords(db);
  migratePeers(db);
  migrateDocBlocks(db);
  migrateDocuments(db);
  migrateBlobCache(db);
}
