import type { Database } from "bun:sqlite";
import { makeId } from "./ids.ts";
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
  const id = makeId(opts.name, "db");
  const first = emit(db, "databases", id, "name", opts.name);
  emit(db, "databases", id, "created_hlc", first.hlc);
  if (opts.icon !== undefined) emit(db, "databases", id, "icon", opts.icon);
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
  return true;
}
