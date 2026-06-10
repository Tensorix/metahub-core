import type { Database } from "bun:sqlite";
import { newId, slugify, idKind } from "./ids.ts";
import { emit } from "./crdt.ts";
import { getDatabase } from "./databases.ts";
import { listProperties, type PropertyRow } from "./properties.ts";
import { maybeAutoIndex } from "./indexing.ts";
import { resolveCandidates } from "./resolve.ts";
import { keyBetween, keysBetween } from "./fracdex.ts";
import { MhError } from "./errors.ts";

type SqlValue = string | number | null;

/** Scalars push down to SQL; arrays/objects/null are filtered in JS. */
function isSqlScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** Encode a coerced scalar to match what `data ->> '<prop>'` returns. */
function sqlFilterValue(v: string | number | boolean): SqlValue {
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

export interface RecordRow {
  id: string;
  database_id: string;
  values: Record<string, unknown>;
}

interface OrderedRecordRow {
  id: string;
  database_id: string;
  created_hlc: string | null;
  order_key: string | null;
}

/**
 * Resolve one relation value to a concrete record id in the target database.
 * Accepts a full id / unique prefix / name. A well-formed record id that does
 * not (yet) exist passes through unchanged — a forward reference / explicit id
 * escape valve. Names/prefixes that match nothing, or match many, throw.
 */
function resolveRelation(db: Database, prop: PropertyRow, value: string): string {
  const target = prop.config?.database;
  if (!target) return value; // misconfigured relation — leave the value as-is
  const cands = resolveCandidates(db, value, { kind: "rec", databaseId: target });
  const exact = cands.find((c) => c.id === value);
  if (exact) return exact.id;
  if (cands.length === 1) return cands[0]!.id;
  if (cands.length === 0) {
    if (idKind(value) === "rec") return value; // forward reference to a full id
    throw new MhError("not_found", `${prop.name}: no such record in target database: ${value}`);
  }
  throw new MhError("ambiguous", `${prop.name}: ambiguous relation "${value}" (${cands.length} matches); use a full id`);
}

/** Validate + normalize a value for a property's type. Throws on mismatch. */
function coerce(db: Database, prop: PropertyRow, value: unknown): unknown {
  switch (prop.type) {
    case "text":
    case "url":
    case "date": {
      if (value === null) return null;
      if (typeof value !== "string") throw new MhError("invalid_input", `${prop.name} expects a string`);
      return value;
    }
    case "number": {
      if (value === null) return null;
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) throw new MhError("invalid_input", `${prop.name} expects a number`);
      return n;
    }
    case "checkbox": {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === 1) return true;
      if (value === "false" || value === 0 || value === null) return false;
      throw new MhError("invalid_input", `${prop.name} expects a boolean`);
    }
    case "select": {
      if (value === null) return null;
      const v = String(value);
      if (!prop.config?.options?.includes(v))
        throw new MhError("invalid_input", `${prop.name}: '${v}' is not an allowed option`);
      return v;
    }
    case "multi_select": {
      const arr = value === null ? [] : Array.isArray(value) ? value : [value];
      const opts = prop.config?.options ?? [];
      for (const item of arr)
        if (!opts.includes(String(item)))
          throw new MhError("invalid_input", `${prop.name}: '${item}' is not an allowed option`);
      return arr.map(String);
    }
    case "relation": {
      const arr = value === null ? [] : Array.isArray(value) ? value : [value];
      return arr.map((v) => resolveRelation(db, prop, String(v)));
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
    if (!prop) throw new MhError("not_found", `unknown property: ${key}`);
    out.push({ prop, value });
  }
  return out;
}

/** Build a RecordRow from a materialized row; keys in `data` are property ids. */
function rowToRecord(
  row: { id: string; database_id: string; data: string },
  props: PropertyRow[],
): RecordRow {
  const raw = JSON.parse(row.data || "{}") as Record<string, unknown>;
  const byId = new Map(props.map((p) => [p.id, p]));
  const values: Record<string, unknown> = {};
  for (const [propId, v] of Object.entries(raw)) {
    const p = byId.get(propId);
    if (p) values[p.name] = v; // skip cells for removed properties
  }
  return { id: row.id, database_id: row.database_id, values };
}

function deriveTitle(
  props: PropertyRow[],
  resolved: { prop: PropertyRow; value: unknown }[],
  fallbackBase: string,
): string {
  const text = resolved.find(
    (r) => r.prop.type === "text" && typeof r.value === "string" && r.value,
  );
  return newId("rec", text ? String(text.value) : "", fallbackBase);
}

function tableExists(db: Database, table: string): boolean {
  return (
    db
      .query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) != null
  );
}

function canEmitOrderKeys(db: Database): boolean {
  return tableExists(db, "meta") && tableExists(db, "crdt_changes");
}

function writeRecordOrderKey(db: Database, recordId: string, orderKey: string, emitChange: boolean): void {
  if (emitChange) emit(db, "records", recordId, "order_key", orderKey);
  else db.query("UPDATE records SET order_key = ? WHERE id = ?").run(orderKey, recordId);
}

function lastRecordOrderKey(db: Database, databaseId: string): string | null {
  const row = db
    .query(
      `SELECT order_key FROM records
       WHERE database_id = ? AND __deleted = 0 AND order_key IS NOT NULL
       ORDER BY order_key DESC, id DESC LIMIT 1`,
    )
    .get(databaseId) as { order_key: string | null } | null;
  return row?.order_key ?? null;
}

function orderedRecordRows(db: Database, databaseId: string): OrderedRecordRow[] {
  return db
    .query(
      `SELECT id, database_id, created_hlc, order_key FROM records
       WHERE database_id = ? AND __deleted = 0
       ORDER BY order_key IS NULL, order_key, created_hlc, id`,
    )
    .all(databaseId) as OrderedRecordRow[];
}

function rebalanceRecordOrderKeys(db: Database, databaseId: string): void {
  const rows = orderedRecordRows(db, databaseId);
  const keys = keysBetween(null, null, rows.length);
  rows.forEach((row, i) => {
    if (row.order_key !== keys[i]) emit(db, "records", row.id, "order_key", keys[i]!);
  });
}

export function backfillRecordOrderKeys(db: Database, databaseId?: string): void {
  const emitChange = canEmitOrderKeys(db);
  const dbRows = databaseId
    ? [{ database_id: databaseId }]
    : (db
        .query(
          `SELECT DISTINCT database_id FROM records
           WHERE database_id IS NOT NULL AND __deleted = 0 AND order_key IS NULL`,
        )
        .all() as { database_id: string }[]);

  for (const d of dbRows) {
    const missing = db
      .query(
        `SELECT id FROM records
         WHERE database_id = ? AND __deleted = 0 AND order_key IS NULL
         ORDER BY created_hlc, id`,
      )
      .all(d.database_id) as { id: string }[];
    if (!missing.length) continue;

    const start = lastRecordOrderKey(db, d.database_id);
    const keys = keysBetween(start, null, missing.length);
    missing.forEach((row, i) => writeRecordOrderKey(db, row.id, keys[i]!, emitChange));
  }
}

export function createRecord(
  db: Database,
  databaseId: string,
  data: Record<string, unknown>,
): RecordRow {
  const dbRow = getDatabase(db, databaseId);
  if (!dbRow) throw new MhError("not_found", `no such database: ${databaseId}`);
  const props = listProperties(db, databaseId);
  const resolved = resolveData(props, data);
  const id = deriveTitle(props, resolved, slugify(dbRow.name, "rec"));
  const orderKey = keyBetween(lastRecordOrderKey(db, databaseId), null);

  const first = emit(db, "records", id, "database_id", databaseId);
  emit(db, "records", id, "created_hlc", first.hlc);
  emit(db, "records", id, "order_key", orderKey);
  for (const { prop, value } of resolved)
    emit(db, "records", id, prop.id, coerce(db, prop, value));
  return getRecord(db, id)!;
}

export function getRecord(db: Database, id: string): RecordRow | null {
  const row = db
    .query("SELECT id, database_id, data FROM records WHERE id = ? AND __deleted = 0")
    .get(id) as { id: string; database_id: string; data: string } | null;
  if (!row) return null;
  return rowToRecord(row, listProperties(db, row.database_id));
}

/** Quote a property id for embedding in a JSON path / index expression. */
function jsonKeyLit(propId: string): string {
  return propId.replace(/'/g, "''");
}

export function listRecords(
  db: Database,
  databaseId: string,
  opts: { filter?: Record<string, unknown>; sort?: string; limit?: number } = {},
): RecordRow[] {
  const props = listProperties(db, databaseId);

  // Coerce filters, then split: scalars push down to SQL (and earn an index),
  // arrays/objects/null are matched in JS afterward.
  const resolved =
    opts.filter && Object.keys(opts.filter).length
      ? resolveData(props, opts.filter).map(({ prop, value }) => ({
          prop,
          value: coerce(db, prop, value),
        }))
      : [];
  const sqlFilters = resolved.filter((f) => isSqlScalar(f.value));
  const jsFilters = resolved.filter((f) => !isSqlScalar(f.value));

  // Resolve sort: default created_hlc; "-field" = descending.
  let sortProp: PropertyRow | undefined;
  let sortDesc = false;
  if (opts.sort) {
    let key = opts.sort;
    if (key.startsWith("-")) {
      sortDesc = true;
      key = key.slice(1);
    }
    if (key !== "created" && key !== "created_hlc") {
      const p = props.find(
        (p) => p.name.toLowerCase() === key.toLowerCase() || p.id === key,
      );
      if (!p) throw new MhError("not_found", `unknown sort field: ${key}`);
      sortProp = p;
    }
  }

  // The act of filtering/sorting on a field is the signal to (maybe) index it.
  for (const f of sqlFilters) maybeAutoIndex(db, databaseId, f.prop);
  if (sortProp) maybeAutoIndex(db, databaseId, sortProp);

  const where = ["database_id = ?", "__deleted = 0"];
  const args: SqlValue[] = [databaseId];
  for (const f of sqlFilters) {
    where.push(`data ->> '${jsonKeyLit(f.prop.id)}' = ?`);
    args.push(sqlFilterValue(f.value as string | number | boolean));
  }

  const manualOrder = opts.sort == null;
  const orderExpr = sortProp
    ? `data ->> '${jsonKeyLit(sortProp.id)}'`
    : "created_hlc";
  let sql =
    `SELECT id, database_id, data FROM records WHERE ${where.join(" AND ")} ` +
    (manualOrder
      ? "ORDER BY order_key IS NULL, order_key, id"
      : `ORDER BY ${orderExpr} ${sortDesc ? "DESC" : "ASC"}, id`);

  // LIMIT only pushes down when no JS-side filtering remains.
  const pushLimit = opts.limit != null && jsFilters.length === 0;
  if (pushLimit) {
    sql += " LIMIT ?";
    args.push(opts.limit!);
  }

  let rows = (
    db.query(sql).all(...args) as { id: string; database_id: string; data: string }[]
  ).map((r) => rowToRecord(r, props));

  if (jsFilters.length) {
    rows = rows.filter((r) =>
      jsFilters.every(
        (f) => JSON.stringify(r.values[f.prop.name] ?? null) === JSON.stringify(f.value),
      ),
    );
    if (opts.limit != null) rows = rows.slice(0, opts.limit);
  }
  return rows;
}

export function moveRecord(
  db: Database,
  id: string,
  targetId: string,
  where: "before" | "after",
): RecordRow {
  if (where !== "before" && where !== "after")
    throw new MhError("invalid_input", `unknown move position: ${where}`);

  const src = db
    .query(
      "SELECT id, database_id FROM records WHERE id = ? AND __deleted = 0",
    )
    .get(id) as { id: string; database_id: string } | null;
  if (!src) throw new MhError("not_found", `no such record: ${id}`);
  const target = db
    .query(
      "SELECT id, database_id FROM records WHERE id = ? AND __deleted = 0",
    )
    .get(targetId) as { id: string; database_id: string } | null;
  if (!target) throw new MhError("not_found", `no such record: ${targetId}`);
  if (src.database_id !== target.database_id)
    throw new MhError("invalid_input", "cannot move a record across databases");
  if (id === targetId) return getRecord(db, id)!;

  backfillRecordOrderKeys(db, src.database_id);

  let rows = orderedRecordRows(db, src.database_id).filter((r) => r.id !== id);
  let to = rows.findIndex((r) => r.id === targetId);
  if (to < 0) throw new MhError("not_found", `no such target record: ${targetId}`);

  let left = where === "before" ? (rows[to - 1]?.order_key ?? null) : rows[to]!.order_key;
  let right = where === "before" ? rows[to]!.order_key : (rows[to + 1]?.order_key ?? null);
  if (left !== null && right !== null && left >= right) {
    rebalanceRecordOrderKeys(db, src.database_id);
    rows = orderedRecordRows(db, src.database_id).filter((r) => r.id !== id);
    to = rows.findIndex((r) => r.id === targetId);
    left = where === "before" ? (rows[to - 1]?.order_key ?? null) : rows[to]!.order_key;
    right = where === "before" ? rows[to]!.order_key : (rows[to + 1]?.order_key ?? null);
  }
  emit(db, "records", id, "order_key", keyBetween(left, right));
  return getRecord(db, id)!;
}

export function updateRecord(
  db: Database,
  id: string,
  data: Record<string, unknown>,
): RecordRow {
  const rec = db
    .query("SELECT id, database_id FROM records WHERE id = ? AND __deleted = 0")
    .get(id) as { id: string; database_id: string } | null;
  if (!rec) throw new MhError("not_found", `no such record: ${id}`);
  const resolved = resolveData(listProperties(db, rec.database_id), data);
  for (const { prop, value } of resolved)
    emit(db, "records", id, prop.id, coerce(db, prop, value));
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
