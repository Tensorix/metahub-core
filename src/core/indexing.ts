import type { Database } from "bun:sqlite";
import type { PropertyRow } from "./properties.ts";

// Records of all databases share one `records` table; indexes are partial on
// database_id so they stay small and per-collection. A field is indexed only
// when it's actually used to filter/sort AND the collection is large enough to
// matter — small tables scan instantly and don't earn the write cost.
const AUTO_INDEX_ROW_THRESHOLD = 2000;

/** SQLite identifiers we build are slug+suffix ids; keep only safe chars. */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Escape a string for embedding as a single-quoted SQL literal. */
function lit(s: string): string {
  return s.replace(/'/g, "''");
}

function indexName(databaseId: string, propId: string): string {
  return `idx_rec_${sanitize(databaseId)}_${sanitize(propId)}`;
}

export function hasIndex(db: Database, databaseId: string, propId: string): boolean {
  const row = db
    .query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(indexName(databaseId, propId)) as { ok: number } | null;
  return row != null;
}

/**
 * Create an expression index on `data ->> '<propId>'` (with created_hlc as the
 * sort tail), partial on this database. Idempotent. The expression matches
 * exactly what listRecords emits, so the optimizer uses it.
 */
export function ensurePropIndex(db: Database, databaseId: string, propId: string): void {
  const name = indexName(databaseId, propId);
  db.exec(
    `CREATE INDEX IF NOT EXISTS "${name}" ON records (data ->> '${lit(propId)}', created_hlc) ` +
      `WHERE database_id = '${lit(databaseId)}' AND __deleted = 0`,
  );
}

/**
 * Ensure an index for a field that a query filters/sorts on — but only when it
 * will pay off. relation fields are almost always query keys (cheap, index
 * eagerly); other fields wait until the collection crosses the row threshold.
 */
export function maybeAutoIndex(db: Database, databaseId: string, prop: PropertyRow): void {
  if (hasIndex(db, databaseId, prop.id)) return;
  if (prop.type !== "relation") {
    const row = db
      .query(
        "SELECT COUNT(*) AS c FROM records WHERE database_id = ? AND __deleted = 0",
      )
      .get(databaseId) as { c: number };
    if (row.c < AUTO_INDEX_ROW_THRESHOLD) return;
  }
  ensurePropIndex(db, databaseId, prop.id);
}
