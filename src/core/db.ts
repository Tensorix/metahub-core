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

/** Open (and migrate) the on-disk metahub database for the resolved home. */
export function openMetahub(): Database {
  ensureDirs();
  const db = new Database(dbPath(), { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  runSchema(db);
  return db;
}
