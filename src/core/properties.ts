import type { DbDriver } from "./driver.ts";
import { newId } from "./ids.ts";
import { emit, grouped } from "./crdt.ts";
import { getDatabase } from "./databases.ts";
import { ensurePropIndex } from "./indexing.ts";
import { MhError } from "./errors.ts";
import type { ColumnsOf } from "./sqlcols.ts";

export type PropType =
  | "text"
  | "number"
  | "checkbox"
  | "select"
  | "multi_select"
  | "date"
  | "relation"
  | "url";

export const PROP_TYPES: ReadonlySet<string> = new Set([
  "text",
  "number",
  "checkbox",
  "select",
  "multi_select",
  "date",
  "relation",
  "url",
]);

export interface PropertyConfig {
  options?: string[]; // select / multi_select
  database?: string; // relation target database id
  indexed?: boolean; // hot query key — materialize an index for this field
  width?: number; // table column width in px (UI metadata, replicated via config)
}

export interface PropertyRow {
  id: string;
  database_id: string;
  name: string;
  type: PropType;
  config: PropertyConfig | null;
  position: number;
}

// SQL returns config as a JSON string; rows are parsed into PropertyRow after.
export const PROPERTY_COLS = ["id", "database_id", "name", "type", "config", "position"] as const;
const _propertyCols: ColumnsOf<PropertyRow, typeof PROPERTY_COLS> = PROPERTY_COLS;
const PROPERTY_SELECT = PROPERTY_COLS.join(", ");

function validateConfig(type: PropType, config: PropertyConfig | undefined): void {
  if (type === "select" || type === "multi_select") {
    const opts = config?.options;
    if (!Array.isArray(opts) || opts.length === 0 || !opts.every((o) => typeof o === "string"))
      throw new MhError("invalid_input", `${type} requires config.options: string[]`);
  }
  if (type === "relation") {
    if (typeof config?.database !== "string")
      throw new MhError("invalid_input", "relation requires config.database (target database id)");
  }
}

function nextPosition(db: DbDriver, databaseId: string): number {
  const row = db
    .query(
      "SELECT MAX(position) AS m FROM properties WHERE database_id = ? AND __deleted = 0",
    )
    .get(databaseId) as { m: number | null };
  return (row.m ?? 0) + 1;
}

export const addProperty = grouped(function addProperty(
  db: DbDriver,
  databaseId: string,
  opts: {
    name: string;
    type: PropType;
    config?: PropertyConfig;
    position?: number;
    // Low-level hint for built-in features that know a field is a hot query
    // key (e.g. an IM conversation id). Not surfaced to CLI users — ad-hoc
    // fields get indexed automatically from query usage (see indexing.ts).
    indexed?: boolean;
  },
): PropertyRow {
  if (!getDatabase(db, databaseId)) throw new MhError("not_found", `no such database: ${databaseId}`);
  if (!PROP_TYPES.has(opts.type)) throw new MhError("invalid_input", `unknown property type: ${opts.type}`);
  validateConfig(opts.type, opts.config);

  // Persist the indexed hint in config so it replicates to peers and survives
  // snapshot/restore (the index itself is derived, not in the oplog).
  const config: PropertyConfig | null = opts.indexed
    ? { ...(opts.config ?? {}), indexed: true }
    : (opts.config ?? null);

  const id = newId("prop", opts.name);
  emit(db, "properties", id, "database_id", databaseId);
  emit(db, "properties", id, "name", opts.name);
  emit(db, "properties", id, "type", opts.type);
  emit(db, "properties", id, "config", config);
  emit(db, "properties", id, "position", opts.position ?? nextPosition(db, databaseId));

  // Relations are almost always query keys; index eagerly. Honor explicit hint.
  if (opts.type === "relation" || opts.indexed === true)
    ensurePropIndex(db, databaseId, id);
  return getProperty(db, id)!;
});

export function getProperty(db: DbDriver, id: string): PropertyRow | null {
  const row = db
    .query(`SELECT ${PROPERTY_SELECT} FROM properties WHERE id = ? AND __deleted = 0`)
    .get(id) as (Omit<PropertyRow, "config"> & { config: string | null }) | null;
  if (!row) return null;
  return { ...row, config: row.config ? (JSON.parse(row.config) as PropertyConfig) : null };
}

export function listProperties(db: DbDriver, databaseId: string): PropertyRow[] {
  const rows = db
    .query(
      `SELECT ${PROPERTY_SELECT} FROM properties WHERE database_id = ? AND __deleted = 0 ORDER BY position`,
    )
    .all(databaseId) as (Omit<PropertyRow, "config"> & { config: string | null })[];
  return rows.map((r) => ({
    ...r,
    config: r.config ? (JSON.parse(r.config) as PropertyConfig) : null,
  }));
}

export const updateProperty = grouped(function updateProperty(
  db: DbDriver,
  id: string,
  fields: { name?: string; type?: PropType; config?: PropertyConfig; position?: number },
): PropertyRow {
  const cur = getProperty(db, id);
  if (!cur) throw new MhError("not_found", `no such property: ${id}`);

  const typeChanged = fields.type !== undefined && fields.type !== cur.type;
  if (fields.type !== undefined && !PROP_TYPES.has(fields.type))
    throw new MhError("invalid_input", `unknown property type: ${fields.type}`);

  // `config` is a patch merged into the existing config server-side (a key set
  // to null is removed), so a caller writing one key can't strip siblings —
  // e.g. an options edit must not wipe the column width. Validate the merged
  // result against whichever type will be in effect.
  const effectiveType = fields.type ?? cur.type;
  let mergedConfig: PropertyConfig | undefined;
  if (fields.config !== undefined) {
    const merged: Record<string, unknown> = { ...(cur.config ?? {}) };
    for (const [k, v] of Object.entries(fields.config)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    mergedConfig = merged as PropertyConfig;
    validateConfig(effectiveType, mergedConfig);
  } else if (typeChanged) validateConfig(fields.type!, cur.config ?? undefined);

  if (fields.name !== undefined) emit(db, "properties", id, "name", fields.name);
  if (fields.type !== undefined) emit(db, "properties", id, "type", fields.type);
  if (mergedConfig !== undefined) emit(db, "properties", id, "config", mergedConfig);
  if (fields.position !== undefined) emit(db, "properties", id, "position", fields.position);

  // A type change invalidates existing cell values (a number may not be a valid
  // select option, etc.), so clear the cells that currently hold a value for
  // this property. The field is keyed by property id in the records data JSON.
  if (typeChanged) {
    const rows = db
      .query(
        "SELECT id FROM records WHERE database_id = ? AND __deleted = 0 AND data ->> ? IS NOT NULL",
      )
      .all(cur.database_id, id) as { id: string }[];
    for (const r of rows) emit(db, "records", r.id, id, null);
  }
  return getProperty(db, id)!;
});

// Persist a column's display width. Merges into the existing config server-side
// so concurrent callers can't strip sibling fields (e.g. a select's `options`),
// and clamps to a sane range. The width replicates with `config` via the oplog.
export function setPropertyWidth(db: DbDriver, id: string, width: number): PropertyRow {
  const cur = getProperty(db, id);
  if (!cur) throw new MhError("not_found", `no such property: ${id}`);
  if (!Number.isFinite(width)) throw new MhError("invalid_input", "width must be a finite number");
  const w = Math.max(80, Math.min(2000, Math.round(width)));
  return updateProperty(db, id, { config: { ...(cur.config ?? {}), width: w } });
}

/** Look up a select/multi_select property and its options, or throw. */
function getSelectProperty(db: DbDriver, id: string): { prop: PropertyRow; options: string[] } {
  const prop = getProperty(db, id);
  if (!prop) throw new MhError("not_found", `no such property: ${id}`);
  if (prop.type !== "select" && prop.type !== "multi_select")
    throw new MhError("invalid_input", `${prop.type} property has no options`);
  return { prop, options: prop.config?.options ?? [] };
}

// Rename one select/multi_select option and rewrite every cell holding the old
// string — cell values store the option string literally, so a config-only
// rename would orphan them (unchecked in menus, ungrouped on boards, rejected
// by coerce on the next write). All emits share one change group, so history
// clusters the rename into a single revision and revert restores cells too.
export const renameSelectOption = grouped(function renameSelectOption(
  db: DbDriver,
  id: string,
  from: string,
  to: string,
): { property: PropertyRow; renamed: number } {
  const { prop, options } = getSelectProperty(db, id);
  to = to.trim();
  if (!to) throw new MhError("invalid_input", "option name must not be empty");
  if (!options.includes(from)) throw new MhError("not_found", `no such option: ${from}`);
  if (to === from) return { property: prop, renamed: 0 };
  if (options.includes(to)) throw new MhError("conflict", `option already exists: ${to}`);

  emit(db, "properties", id, "config", {
    ...(prop.config ?? {}),
    options: options.map((o) => (o === from ? to : o)),
  });

  let renamed = 0;
  if (prop.type === "select") {
    const rows = db
      .query("SELECT id FROM records WHERE database_id = ? AND __deleted = 0 AND data ->> ? = ?")
      .all(prop.database_id, id, from) as { id: string }[];
    for (const r of rows) emit(db, "records", r.id, id, to);
    renamed = rows.length;
  } else {
    const rows = db
      .query(
        "SELECT id, data ->> ? AS v FROM records WHERE database_id = ? AND __deleted = 0 AND data ->> ? IS NOT NULL",
      )
      .all(id, prop.database_id, id) as { id: string; v: string }[];
    for (const r of rows) {
      const vals = JSON.parse(r.v) as unknown;
      if (!Array.isArray(vals) || !vals.includes(from)) continue;
      // Dedupe in case a cell already holds the target name alongside the old one.
      emit(db, "records", r.id, id, [...new Set(vals.map((v) => (v === from ? to : v)))]);
      renamed++;
    }
  }
  return { property: getProperty(db, id)!, renamed };
});

// Remove one option and clear it from every cell that uses it — mirrors the
// cell cleanup removeProperty does, so no orphaned strings linger.
export const removeSelectOption = grouped(function removeSelectOption(
  db: DbDriver,
  id: string,
  name: string,
): { property: PropertyRow; cleared: number } {
  const { prop, options } = getSelectProperty(db, id);
  if (!options.includes(name)) throw new MhError("not_found", `no such option: ${name}`);
  if (options.length === 1)
    throw new MhError("invalid_input", "cannot remove the last option; delete the property instead");

  emit(db, "properties", id, "config", {
    ...(prop.config ?? {}),
    options: options.filter((o) => o !== name),
  });

  let cleared = 0;
  if (prop.type === "select") {
    const rows = db
      .query("SELECT id FROM records WHERE database_id = ? AND __deleted = 0 AND data ->> ? = ?")
      .all(prop.database_id, id, name) as { id: string }[];
    for (const r of rows) emit(db, "records", r.id, id, null);
    cleared = rows.length;
  } else {
    const rows = db
      .query(
        "SELECT id, data ->> ? AS v FROM records WHERE database_id = ? AND __deleted = 0 AND data ->> ? IS NOT NULL",
      )
      .all(id, prop.database_id, id) as { id: string; v: string }[];
    for (const r of rows) {
      const vals = JSON.parse(r.v) as unknown;
      if (!Array.isArray(vals) || !vals.includes(name)) continue;
      emit(db, "records", r.id, id, vals.filter((v) => v !== name));
      cleared++;
    }
  }
  return { property: getProperty(db, id)!, cleared };
});

export const removeProperty = grouped(function removeProperty(db: DbDriver, id: string): boolean {
  const prop = getProperty(db, id);
  if (!prop) return false;
  emit(db, "properties", id, "__deleted", 1);
  // Clear this property's now-orphaned cells (keyed by property id in the records
  // data JSON) so no dead cell data lingers — same cleanup repairHub would do off
  // the property tombstone. emit(undefined) materializes to json_remove.
  const rows = db
    .query(
      "SELECT id FROM records WHERE database_id = ? AND __deleted = 0 AND data ->> ? IS NOT NULL",
    )
    .all(prop.database_id, id) as { id: string }[];
  for (const r of rows) emit(db, "records", r.id, id, undefined);
  return true;
});
