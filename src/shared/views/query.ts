import type { DbDriver } from "../../core/driver.ts";
import { listProperties } from "../../core/properties.ts";
import type { RecordRow } from "../../core/records.ts";
import { applyFilter, compareCells, searchRecords, type FilterSet, type SortRule } from "./model.ts";

export interface RecordQuery {
  search?: string;
  filter?: FilterSet;
  sort?: SortRule[];
  offset?: number;
  limit?: number;
}
/** Scan in bounded chunks, retaining only the requested sorted prefix. Filters
 * and search apply to the entire database before pagination, including ties. */
function* scanRecords(db: DbDriver, databaseId: string, query: RecordQuery = {}) {
  // Derived index is local-only; it keeps repeated bounded scans in manual order cheap.
  db.exec("CREATE INDEX IF NOT EXISTS idx_mobile_record_page ON records(database_id, __deleted, order_key IS NULL, order_key, id)");
  const props = listProperties(db, databaseId);
  const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(200, Math.floor(query.limit!))) : 60;
  const offset = Number.isFinite(query.offset) ? Math.max(0, Math.floor(query.offset!)) : 0;
  const keep = offset + limit;
  const sort = (query.sort ?? []).flatMap(rule => {
    const prop = props.find(p => p.id === rule.prop);
    return prop ? [{ rule, prop }] : [];
  });
  const compare = (a: RecordRow, b: RecordRow) => {
    for (const { rule, prop } of sort) {
      const result = compareCells(prop, a.cells[prop.id], b.cells[prop.id]);
      if (result && Number.isFinite(result)) return rule.desc ? -result : result;
      // +/-Infinity are valid comparisons for an empty numeric cell.
      if (result === Infinity || result === -Infinity) return rule.desc ? -result : result;
    }
    return 0;
  };
  // Manual-order lists can page directly through the index. Scanning and
  // parsing every record on every scroll page is unnecessary without predicates.
  if (!sort.length && !query.search?.trim() && !query.filter?.rules.length) {
    yield; // Preserve cancellation before the async facade reads the page.
    const total = (db.query("SELECT count(*) AS n FROM records WHERE database_id = ? AND __deleted = 0").get(databaseId) as { n: number }).n;
    const rows = db.query("SELECT id, database_id, data FROM records WHERE database_id = ? AND __deleted = 0 ORDER BY order_key IS NULL, order_key, id LIMIT ? OFFSET ?").all(databaseId, limit, offset) as { id: string; database_id: string; data: string }[];
    const records = rows.map(row => {
      const raw = JSON.parse(row.data || "{}") as Record<string, unknown>;
      const cells: Record<string, unknown> = {}, values: Record<string, unknown> = {};
      for (const prop of props) if (Object.hasOwn(raw, prop.id)) { cells[prop.id] = raw[prop.id]; values[prop.name] = raw[prop.id]; }
      return { id: row.id, database_id: row.database_id, cells, values };
    });
    return { records, total, hasMore: total > offset + limit, offset, limit };
  }
  const retained: RecordRow[] = [];
  let total = 0;
  for (let scan = 0; ; scan += 200) {
    const chunk = db.query("SELECT id, database_id, data FROM records WHERE database_id = ? AND __deleted = 0 ORDER BY order_key IS NULL, order_key, id LIMIT 200 OFFSET ?").all(databaseId, scan) as { id: string; database_id: string; data: string }[];
    for (const row of chunk) {
      const raw = JSON.parse(row.data || "{}") as Record<string, unknown>;
      const cells: Record<string, unknown> = {}, values: Record<string, unknown> = {};
      for (const prop of props) if (Object.hasOwn(raw, prop.id)) { cells[prop.id] = raw[prop.id]; values[prop.name] = raw[prop.id]; }
      const rec: RecordRow = { id: row.id, database_id: row.database_id, cells, values };
      if (query.filter && !applyFilter([rec], props, query.filter).length) continue;
      if (!searchRecords([rec], props, query.search ?? "").length) continue;
      total++;
      if (!sort.length) { if (retained.length < keep) retained.push(rec); continue; }
      let low = 0, high = retained.length;
      while (low < high) { const mid = (low + high) >>> 1; if (compare(rec, retained[mid]!) < 0) high = mid; else low = mid + 1; }
      if (low < keep) { retained.splice(low, 0, rec); if (retained.length > keep) retained.pop(); }
    }
    if (chunk.length < 200) break;
    yield;
  }
  return { records: retained.slice(offset), total, hasMore: total > offset + limit, offset, limit };
}

export function queryRecords(db: DbDriver, databaseId: string, query: RecordQuery = {}) {
  const scan = scanRecords(db, databaseId, query);
  let step = scan.next();
  while (!step.done) step = scan.next();
  return step.value;
}
/** Yield between SQLite chunks so native gestures and cancellation can run. */
export async function queryRecordsAsync(db: DbDriver, databaseId: string, query: RecordQuery = {}, isCurrent = () => true) {
  const scan = scanRecords(db, databaseId, query);
  for (;;) {
    if (!isCurrent()) throw new Error("Replica query cancelled");
    const step = scan.next();
    if (step.done) return step.value;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

/** Reference pickers only need document summaries; never hydrate their bodies. */
export function queryDocuments(db: DbDriver, query: {search?: string; offset?: number; limit?: number} = {}) {
  const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(200, Math.floor(query.limit!))) : 60;
  const offset = Number.isFinite(query.offset) ? Math.max(0, Math.floor(query.offset!)) : 0;
  const needle = `%${(query.search ?? "").trim().replace(/[\\%_]/g, "\\$&")}%`;
  const where = "__deleted = 0 AND (title LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')";
  const total = (db.query(`SELECT count(*) AS n FROM documents WHERE ${where}`).get(needle, needle) as {n:number}).n;
  const documents = db.query(`SELECT id, title, database_id, parent_id, created_hlc, order_key FROM documents WHERE ${where} ORDER BY order_key IS NULL, order_key, id LIMIT ? OFFSET ?`).all(needle, needle, limit, offset) as import("../../core/documents.ts").DocumentSummary[];
  return {documents,total,hasMore:total > offset + limit,offset,limit};
}
