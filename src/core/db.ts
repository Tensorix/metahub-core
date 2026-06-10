import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dbPath, cacheDir, metahubHome } from "./paths.ts";
import { CORE_SCHEMA, FTS_SCHEMA } from "./schema.ts";
import { backfillRecordOrderKeys } from "./records.ts";
import { backfillDocumentOrderKeys } from "./documents.ts";

export function ensureDirs(): void {
  mkdirSync(metahubHome(), { recursive: true });
  mkdirSync(cacheDir(), { recursive: true });
}

export function runSchema(db: Database): void {
  db.exec(CORE_SCHEMA);
  try {
    db.exec(FTS_SCHEMA);
  } catch {
    // FTS5 unavailable; search will fall back to LIKE.
  }
}

export function ftsAvailable(db: Database): boolean {
  const row = db
    .query("SELECT 1 AS ok FROM sqlite_master WHERE name = 'search_fts'")
    .get() as { ok: number } | null;
  return row != null;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function tableExists(db: Database, table: string): boolean {
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
export function migrateRecords(db: Database): void {
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
 * enabled/last_sync_at/last_status/last_error). Idempotent — guarded per column,
 * never drops the table so existing replication cursors survive.
 */
export function migratePeers(db: Database): void {
  const add: [string, string][] = [
    ["token", "TEXT"],
    ["label", "TEXT"],
    ["node_id", "TEXT"],
    ["enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["last_sync_at", "INTEGER"],
    ["last_status", "TEXT"],
    ["last_error", "TEXT"],
  ];
  for (const [col, decl] of add) {
    if (!hasColumn(db, "peers", col)) db.exec(`ALTER TABLE peers ADD COLUMN ${col} ${decl}`);
  }
}

/**
 * Add the `blank_after` column to a legacy `doc_blocks` table. Idempotent —
 * guarded by hasColumn; existing blocks default to 0 (canonical single-blank-line
 * separators), so the migration never changes an existing document's body.
 */
export function migrateDocBlocks(db: Database): void {
  if (!hasColumn(db, "doc_blocks", "blank_after"))
    db.exec("ALTER TABLE doc_blocks ADD COLUMN blank_after INTEGER NOT NULL DEFAULT 0");
}

/**
 * Add the `order_key` column to a legacy `documents` table and backfill it.
 * Idempotent — guarded by hasColumn; backfill only touches rows with a NULL key,
 * assigning per-parent fractional indices in current created_hlc order, so the
 * displayed document order is unchanged until the user first drags something.
 */
export function migrateDocuments(db: Database): void {
  if (!hasColumn(db, "documents", "order_key"))
    db.exec("ALTER TABLE documents ADD COLUMN order_key TEXT");
  backfillDocumentOrderKeys(db);
}

/**
 * Add the `txn` change-group column to a legacy `crdt_changes` table.
 * Idempotent — guarded by hasColumn; existing rows stay NULL (history falls
 * back to time-gap clustering for them).
 */
export function migrateOplog(db: Database): void {
  if (!hasColumn(db, "crdt_changes", "txn"))
    db.exec("ALTER TABLE crdt_changes ADD COLUMN txn TEXT");
}

/** Open (and migrate) the on-disk metahub database for the resolved home. */
export function openMetahub(): Database {
  ensureDirs();
  const db = new Database(dbPath(), { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  runSchema(db);
  migrateOplog(db);
  migrateRecords(db);
  migratePeers(db);
  migrateDocBlocks(db);
  migrateDocuments(db);
  return db;
}
