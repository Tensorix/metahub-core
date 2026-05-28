import type { Database } from "bun:sqlite";
import { makeId, slugify } from "./ids.ts";
import { emit } from "./crdt.ts";
import { getDatabase } from "./databases.ts";
import { listProperties, type PropertyRow } from "./properties.ts";

export interface RecordRow {
  id: string;
  database_id: string;
  values: Record<string, unknown>;
}

/** Validate + normalize a value for a property's type. Throws on mismatch. */
function coerce(prop: PropertyRow, value: unknown): unknown {
  switch (prop.type) {
    case "text":
    case "url":
    case "date": {
      if (value === null) return null;
      if (typeof value !== "string") throw new Error(`${prop.name} expects a string`);
      return value;
    }
    case "number": {
      if (value === null) return null;
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) throw new Error(`${prop.name} expects a number`);
      return n;
    }
    case "checkbox": {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === 1) return true;
      if (value === "false" || value === 0 || value === null) return false;
      throw new Error(`${prop.name} expects a boolean`);
    }
    case "select": {
      if (value === null) return null;
      const v = String(value);
      if (!prop.config?.options?.includes(v))
        throw new Error(`${prop.name}: '${v}' is not an allowed option`);
      return v;
    }
    case "multi_select": {
      const arr = value === null ? [] : Array.isArray(value) ? value : [value];
      const opts = prop.config?.options ?? [];
      for (const item of arr)
        if (!opts.includes(String(item)))
          throw new Error(`${prop.name}: '${item}' is not an allowed option`);
      return arr.map(String);
    }
    case "relation": {
      const arr = value === null ? [] : Array.isArray(value) ? value : [value];
      return arr.map(String);
    }
  }
}

/** Match data keys (property name OR id) to properties. */
function resolveData(
  props: PropertyRow[],
  data: Record<string, unknown>,
): { prop: PropertyRow; value: unknown }[] {
  const byId = new Map(props.map((p) => [p.id, p]));
  const byName = new Map(props.map((p) => [p.name.toLowerCase(), p]));
  const out: { prop: PropertyRow; value: unknown }[] = [];
  for (const [key, value] of Object.entries(data)) {
    const prop = byId.get(key) ?? byName.get(key.toLowerCase());
    if (!prop) throw new Error(`unknown property: ${key}`);
    out.push({ prop, value });
  }
  return out;
}

function readRecord(
  db: Database,
  id: string,
  databaseId: string,
  props: PropertyRow[],
): RecordRow {
  const cells = db
    .query("SELECT property_id, value FROM record_values WHERE record_id = ?")
    .all(id) as { property_id: string; value: string | null }[];
  const byId = new Map(props.map((p) => [p.id, p]));
  const values: Record<string, unknown> = {};
  for (const c of cells) {
    const p = byId.get(c.property_id);
    if (!p) continue; // cell for a removed property
    values[p.name] = c.value === null ? null : JSON.parse(c.value);
  }
  return { id, database_id: databaseId, values };
}

function deriveTitle(
  props: PropertyRow[],
  resolved: { prop: PropertyRow; value: unknown }[],
  fallbackBase: string,
): string {
  const text = resolved.find(
    (r) => r.prop.type === "text" && typeof r.value === "string" && r.value,
  );
  return makeId(text ? String(text.value) : "", fallbackBase);
}

export function createRecord(
  db: Database,
  databaseId: string,
  data: Record<string, unknown>,
): RecordRow {
  const dbRow = getDatabase(db, databaseId);
  if (!dbRow) throw new Error(`no such database: ${databaseId}`);
  const props = listProperties(db, databaseId);
  const resolved = resolveData(props, data);
  const id = deriveTitle(props, resolved, slugify(dbRow.name, "rec"));

  const first = emit(db, "records", id, "database_id", databaseId);
  emit(db, "records", id, "created_hlc", first.hlc);
  for (const { prop, value } of resolved)
    emit(db, "records", id, prop.id, coerce(prop, value));
  return getRecord(db, id)!;
}

export function getRecord(db: Database, id: string): RecordRow | null {
  const rec = db
    .query("SELECT id, database_id FROM records WHERE id = ? AND __deleted = 0")
    .get(id) as { id: string; database_id: string } | null;
  if (!rec) return null;
  return readRecord(db, rec.id, rec.database_id, listProperties(db, rec.database_id));
}

export function listRecords(
  db: Database,
  databaseId: string,
  opts: { filter?: Record<string, unknown>; limit?: number } = {},
): RecordRow[] {
  const props = listProperties(db, databaseId);
  const recs = db
    .query(
      "SELECT id, database_id FROM records WHERE database_id = ? AND __deleted = 0 ORDER BY created_hlc",
    )
    .all(databaseId) as { id: string; database_id: string }[];
  let rows = recs.map((r) => readRecord(db, r.id, r.database_id, props));

  if (opts.filter && Object.keys(opts.filter).length) {
    const want = resolveData(props, opts.filter).map(({ prop, value }) => ({
      name: prop.name,
      value: coerce(prop, value),
    }));
    rows = rows.filter((r) =>
      want.every((w) => JSON.stringify(r.values[w.name] ?? null) === JSON.stringify(w.value)),
    );
  }
  if (opts.limit != null) rows = rows.slice(0, opts.limit);
  return rows;
}

export function updateRecord(
  db: Database,
  id: string,
  data: Record<string, unknown>,
): RecordRow {
  const rec = db
    .query("SELECT id, database_id FROM records WHERE id = ? AND __deleted = 0")
    .get(id) as { id: string; database_id: string } | null;
  if (!rec) throw new Error(`no such record: ${id}`);
  const resolved = resolveData(listProperties(db, rec.database_id), data);
  for (const { prop, value } of resolved)
    emit(db, "records", id, prop.id, coerce(prop, value));
  return getRecord(db, id)!;
}

export function deleteRecord(db: Database, id: string): boolean {
  const rec = db
    .query("SELECT id FROM records WHERE id = ? AND __deleted = 0")
    .get(id) as { id: string } | null;
  if (!rec) return false;
  emit(db, "records", id, "__deleted", 1);
  return true;
}
