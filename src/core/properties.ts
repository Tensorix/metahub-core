import type { DbDriver } from "./driver.ts";
import { newId } from "./ids.ts";
import { emit, grouped } from "./crdt.ts";
import { getDatabase } from "./databases.ts";
import { ensurePropIndex } from "./indexing.ts";
import { MhError } from "./errors.ts";

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
    .query(
      "SELECT id, database_id, name, type, config, position FROM properties WHERE id = ? AND __deleted = 0",
    )
    .get(id) as (Omit<PropertyRow, "config"> & { config: string | null }) | null;
  if (!row) return null;
  return { ...row, config: row.config ? (JSON.parse(row.config) as PropertyConfig) : null };
}

export function listProperties(db: DbDriver, databaseId: string): PropertyRow[] {
  const rows = db
    .query(
      "SELECT id, database_id, name, type, config, position FROM properties WHERE database_id = ? AND __deleted = 0 ORDER BY position",
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

  // Validate config against whichever type will be in effect.
  const effectiveType = fields.type ?? cur.type;
  if (fields.config !== undefined) validateConfig(effectiveType, fields.config);
  else if (typeChanged) validateConfig(fields.type!, undefined);

  if (fields.name !== undefined) emit(db, "properties", id, "name", fields.name);
  if (fields.type !== undefined) emit(db, "properties", id, "type", fields.type);
  if (fields.config !== undefined) emit(db, "properties", id, "config", fields.config);
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
