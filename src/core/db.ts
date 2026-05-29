import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dbPath, cacheDir, metahubHome } from "./paths.ts";
import { CORE_SCHEMA, FTS_SCHEMA } from "./schema.ts";

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
  });
  tx();
}

/** Open (and migrate) the on-disk metahub database for the resolved home. */
export function openMetahub(): Database {
  ensureDirs();
  const db = new Database(dbPath(), { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  runSchema(db);
  migrateRecords(db);
  return db;
}
