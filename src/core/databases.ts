import type { DbDriver } from "./driver.ts";
import { newId } from "./ids.ts";
import { emit, grouped } from "./crdt.ts";
import { MhError } from "./errors.ts";
import { addProperty, listProperties, type PropertyConfig } from "./properties.ts";
import { createRecord, listRecords } from "./records.ts";
import type { ColumnsOf } from "./sqlcols.ts";

export interface DatabaseRow {
  id: string;
  name: string;
  icon: string | null;
  created_hlc: string;
}

export const DATABASE_COLS = ["id", "name", "icon", "created_hlc"] as const;
const _databaseCols: ColumnsOf<DatabaseRow, typeof DATABASE_COLS> = DATABASE_COLS;
const DATABASE_SELECT = DATABASE_COLS.join(", ");

export const createDatabase = grouped(function createDatabase(
  db: DbDriver,
  opts: { name: string; icon?: string },
): DatabaseRow {
  const id = newId("db", opts.name);
  const first = emit(db, "databases", id, "name", opts.name);
  emit(db, "databases", id, "created_hlc", first.hlc);
  if (opts.icon !== undefined) emit(db, "databases", id, "icon", opts.icon);
  return getDatabase(db, id)!;
});

export const updateDatabase = grouped(function updateDatabase(
  db: DbDriver,
  id: string,
  fields: { name?: string; icon?: string | null },
): DatabaseRow {
  if (!getDatabase(db, id)) throw new MhError("not_found", `no such database: ${id}`);
  if (fields.name !== undefined) emit(db, "databases", id, "name", fields.name);
  if (fields.icon !== undefined) emit(db, "databases", id, "icon", fields.icon);
  return getDatabase(db, id)!;
});

/**
 * Copy a database whole — name, icon, every property (type/config/position
 * preserved) and every record (in order, cells carried via an old→new property
 * id map, so duplicate property names copy losslessly). A relation column
 * pointing back at the *source* database is remapped to the copy so it stays
 * self-referential; relations to other databases keep their target.
 * `name`/`icon` override the defaults; the locale "copy" suffix is the
 * caller's job. All emits share one txn, so the copy syncs as one revision.
 */
export const duplicateDatabase = grouped(function duplicateDatabase(
  db: DbDriver,
  id: string,
  opts: { name?: string; icon?: string } = {},
): DatabaseRow {
  const src = getDatabase(db, id);
  if (!src) throw new MhError("not_found", `no such database: ${id}`);
  const dup = createDatabase(db, {
    name: opts.name ?? src.name,
    icon: (opts.icon ?? src.icon) ?? undefined,
  });
  const propIdMap = new Map<string, string>();
  for (const p of listProperties(db, id)) {
    const config: PropertyConfig | undefined =
      p.config?.database === id ? { ...p.config, database: dup.id } : (p.config ?? undefined);
    const np = addProperty(db, dup.id, { name: p.name, type: p.type, config, position: p.position });
    propIdMap.set(p.id, np.id);
  }
  for (const r of listRecords(db, id)) {
    const data: Record<string, unknown> = {};
    for (const [pid, v] of Object.entries(r.cells)) {
      const nid = propIdMap.get(pid);
      if (nid) data[nid] = v;
    }
    createRecord(db, dup.id, data);
  }
  return getDatabase(db, dup.id)!;
});

export function getDatabase(db: DbDriver, id: string): DatabaseRow | null {
  return db
    .query(`SELECT ${DATABASE_SELECT} FROM databases WHERE id = ? AND __deleted = 0`)
    .get(id) as DatabaseRow | null;
}

export function listDatabases(db: DbDriver): DatabaseRow[] {
  return db
    .query(`SELECT ${DATABASE_SELECT} FROM databases WHERE __deleted = 0 ORDER BY created_hlc`)
    .all() as DatabaseRow[];
}

export const deleteDatabase = grouped(function deleteDatabase(db: DbDriver, id: string): boolean {
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
});

/** Ids of live rows in `table` whose `col` references `parentId`. */
function liveChildren(db: DbDriver, table: string, col: string, parentId: string): string[] {
  return (
    db
      .query(`SELECT id FROM ${table} WHERE ${col} = ? AND __deleted = 0`)
      .all(parentId) as { id: string }[]
  ).map((r) => r.id);
}
