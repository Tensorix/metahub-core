import type { Database } from "bun:sqlite";
import { getDatabase, type DatabaseRow } from "./databases.ts";

// The "current database" is per-machine UI context, not data — it lives in the
// local `meta` table (like node_id / search_hlc), never in the oplog, so it
// does not sync to peers.
const KEY = "current_db";

/**
 * The current database, or null. Validated on read: if it points at a database
 * that no longer exists (deleted, or gone after a snapshot restore), the stale
 * pointer is cleared and null returned — no coupling to delete/restore paths.
 */
export function getCurrentDatabase(db: Database): DatabaseRow | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(KEY) as
    | { value: string }
    | null;
  if (!row) return null;
  const found = getDatabase(db, row.value);
  if (!found) {
    clearCurrentDatabase(db);
    return null;
  }
  return found;
}

export function setCurrentDatabase(db: Database, id: string): void {
  db.query(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(KEY, id);
}

export function clearCurrentDatabase(db: Database): void {
  db.query("DELETE FROM meta WHERE key = ?").run(KEY);
}
