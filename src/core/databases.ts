import type { Database } from "bun:sqlite";
import { newId } from "./ids.ts";
import { emit } from "./crdt.ts";

export interface DatabaseRow {
  id: string;
  name: string;
  icon: string | null;
  created_hlc: string;
}

export function createDatabase(
  db: Database,
  opts: { name: string; icon?: string },
): DatabaseRow {
  const id = newId("db", opts.name);
  const first = emit(db, "databases", id, "name", opts.name);
  emit(db, "databases", id, "created_hlc", first.hlc);
  if (opts.icon !== undefined) emit(db, "databases", id, "icon", opts.icon);
  return getDatabase(db, id)!;
}

export function updateDatabase(
  db: Database,
  id: string,
  fields: { name?: string; icon?: string | null },
): DatabaseRow {
  if (!getDatabase(db, id)) throw new Error(`no such database: ${id}`);
  if (fields.name !== undefined) emit(db, "databases", id, "name", fields.name);
  if (fields.icon !== undefined) emit(db, "databases", id, "icon", fields.icon);
  return getDatabase(db, id)!;
}

export function getDatabase(db: Database, id: string): DatabaseRow | null {
  return db
    .query(
      "SELECT id, name, icon, created_hlc FROM databases WHERE id = ? AND __deleted = 0",
    )
    .get(id) as DatabaseRow | null;
}

export function listDatabases(db: Database): DatabaseRow[] {
  return db
    .query(
      "SELECT id, name, icon, created_hlc FROM databases WHERE __deleted = 0 ORDER BY created_hlc",
    )
    .all() as DatabaseRow[];
}

export function deleteDatabase(db: Database, id: string): boolean {
  if (!getDatabase(db, id)) return false;
  emit(db, "databases", id, "__deleted", 1);

  // Cascade so nothing is left dangling (the same fixes repairHub would make off
  // the database tombstone, applied eagerly here by the deleting node):
  //   - properties/records are meaningless without the database -> tombstone;
  //   - documents keep an optional scope link -> detach so their content survives.
  const tombstone = (table: string) => {
    for (const r of liveChildren(db, table, "database_id", id))
      emit(db, table, r, "__deleted", 1);
  };
  tombstone("properties");
  tombstone("records");
  for (const d of liveChildren(db, "documents", "database_id", id))
    emit(db, "documents", d, "database_id", null);

  // Drop the "current database" pointer if it referenced this one (raw query to
  // avoid a context.ts <-> databases.ts import cycle; read-side also self-heals).
  db.query("DELETE FROM meta WHERE key = 'current_db' AND value = ?").run(id);
  return true;
}

/** Ids of live rows in `table` whose `col` references `parentId`. */
function liveChildren(db: Database, table: string, col: string, parentId: string): string[] {
  return (
    db
      .query(`SELECT id FROM ${table} WHERE ${col} = ? AND __deleted = 0`)
      .all(parentId) as { id: string }[]
  ).map((r) => r.id);
}
