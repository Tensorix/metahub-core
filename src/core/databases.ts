import type { DbDriver } from "./driver.ts";
import { newId } from "./ids.ts";
import { emit, grouped } from "./crdt.ts";
import { MhError } from "./errors.ts";
import { addProperty, listProperties, type PropertyConfig } from "./properties.ts";
import { createRecord, listRecords, updateRecord } from "./records.ts";
import type { ColumnsOf } from "./sqlcols.ts";

export interface DatabaseRow {
  id: string;
  name: string;
  icon: string | null;
  /** Generic replicated metadata, one LWW register per top-level key.
   *  Domain-neutral by design: consumers own their keys (the WebUI sidebar's
   *  `collapsed` flag, the table's saved `views`). */
  meta: Record<string, unknown> | null;
  created_hlc: string;
}

// SQL returns meta as a JSON string; rows are parsed into DatabaseRow after.
export const DATABASE_COLS = ["id", "name", "icon", "meta", "created_hlc"] as const;
const _databaseCols: ColumnsOf<DatabaseRow, typeof DATABASE_COLS> = DATABASE_COLS;
const DATABASE_SELECT = DATABASE_COLS.join(", ");

function rowOut(r: (Omit<DatabaseRow, "meta"> & { meta: string | null }) | null): DatabaseRow | null {
  if (!r) return null;
  const meta = r.meta === null ? null : (JSON.parse(r.meta) as Record<string, unknown> | null);
  return { ...r, meta: meta && Object.keys(meta).length ? meta : null };
}

/** One oplog register per meta key (`meta.<key>`), so two writers of different
 *  keys never clobber each other. `null` removes a key; keys whose value is
 *  unchanged emit nothing. */
function emitMetaPatch(db: DbDriver, id: string, cur: Record<string, unknown> | null, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (k.includes(".")) throw new MhError("invalid_input", `meta key must not contain ".": ${k}`);
    const next = v === undefined ? null : v;
    const prev = cur && k in cur ? cur[k] : null;
    if (JSON.stringify(prev ?? null) === JSON.stringify(next ?? null)) continue;
    emit(db, "databases", id, `meta.${k}`, next === null ? undefined : next);
  }
}

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
  fields: { name?: string; icon?: string | null; meta?: Record<string, unknown> | null },
): DatabaseRow {
  if (!getDatabase(db, id)) throw new MhError("not_found", `no such database: ${id}`);
  if (fields.name !== undefined) emit(db, "databases", id, "name", fields.name);
  if (fields.icon !== undefined) emit(db, "databases", id, "icon", fields.icon);
  // `meta` is a merge patch over per-key registers: only the keys given change,
  // null deletes a key, and `meta: null` clears every key.
  if (fields.meta !== undefined) {
    if (fields.meta !== null && (typeof fields.meta !== "object" || Array.isArray(fields.meta)))
      throw new MhError("invalid_input", "meta must be a JSON object or null");
    const cur = getDatabase(db, id)!.meta;
    const patch = fields.meta ?? Object.fromEntries(Object.keys(cur ?? {}).map((k) => [k, null]));
    emitMetaPatch(db, id, cur, patch);
  }
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
  // Copy meta minus `collapsed`: a duplicate of a folded database must not be
  // born hidden inside the sidebar's collapsed tail group (which defaults to
  // closed) — the user just created it and expects to see it.
  if (src.meta !== null) {
    const { collapsed: _hidden, ...meta } = src.meta as Record<string, unknown>;
    emitMetaPatch(db, dup.id, null, meta);
  }
  const propIdMap = new Map<string, string>();
  const selfRelNew = new Set<string>(); // copy-side prop ids whose relation targets the copy
  for (const p of listProperties(db, id)) {
    const self = p.type === "relation" && p.config?.database === id;
    const config: PropertyConfig | undefined = self
      ? { ...p.config, database: dup.id }
      : (p.config ?? undefined);
    const np = addProperty(db, dup.id, { name: p.name, type: p.type, config, position: p.position });
    propIdMap.set(p.id, np.id);
    if (self) selfRelNew.add(np.id);
  }
  // Self-referential relation cells must point at the copy's rows, but those ids
  // only exist once every row is created — so copy in two passes: rows first
  // (deferring self-relation cells), then rewrite those cells through the
  // old→new record id map. Ids that don't map (already dangling in the source)
  // are kept verbatim.
  const srcRecords = listRecords(db, id);
  const recIdMap = new Map<string, string>();
  for (const r of srcRecords) {
    const data: Record<string, unknown> = {};
    for (const [pid, v] of Object.entries(r.cells)) {
      const nid = propIdMap.get(pid);
      if (!nid) continue;
      if (selfRelNew.has(nid) && Array.isArray(v) && v.length > 0) continue; // pass 2
      data[nid] = v;
    }
    recIdMap.set(r.id, createRecord(db, dup.id, data).id);
  }
  for (const r of srcRecords) {
    const patch: Record<string, unknown> = {};
    for (const [pid, v] of Object.entries(r.cells)) {
      const nid = propIdMap.get(pid);
      if (nid && selfRelNew.has(nid) && Array.isArray(v) && v.length > 0)
        patch[nid] = v.map((x) => recIdMap.get(String(x)) ?? x);
    }
    if (Object.keys(patch).length) updateRecord(db, recIdMap.get(r.id)!, patch);
  }
  return getDatabase(db, dup.id)!;
});

export function getDatabase(db: DbDriver, id: string): DatabaseRow | null {
  return rowOut(
    db
      .query(`SELECT ${DATABASE_SELECT} FROM databases WHERE id = ? AND __deleted = 0`)
      .get(id) as (Omit<DatabaseRow, "meta"> & { meta: string | null }) | null,
  );
}

export function listDatabases(db: DbDriver): DatabaseRow[] {
  const rows = db
    .query(`SELECT ${DATABASE_SELECT} FROM databases WHERE __deleted = 0 ORDER BY created_hlc`)
    .all() as (Omit<DatabaseRow, "meta"> & { meta: string | null })[];
  return rows.map((r) => rowOut(r)!);
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
