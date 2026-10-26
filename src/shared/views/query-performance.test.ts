import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { DbDriver } from "../../core/driver.ts";
import { initSchema, migrateRecords, runSchema } from "../../core/schema-init.ts";
import { keyBetween } from "../../core/fracdex.ts";
import { createReplicaService } from "../../core/replica/service.ts";
import { listRecords } from "../../core/records.ts";
import { applyFilter, applySort, searchRecords } from "./model.ts";
import { queryRecords, queryRecordsAsync } from "./query.ts";

const handles: Database[] = [];
afterEach(() => { for (const db of handles.splice(0)) db.close(); });
function fixture(count = 10000) {
  const db = new Database(":memory:"); handles.push(db); initSchema(db);
  const service = createReplicaService(db);
  const database = service.commands.createDatabase({ name: "Paging" });
  const title = service.commands.addProperty(database.id, { name: "Title", type: "text" });
  const number = service.commands.addProperty(database.id, { name: "Number", type: "number" });
  const insert = db.query("INSERT INTO records(id,database_id,order_key,data) VALUES(?,?,?,?)");
  let key: string | null = null;
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      key = keyBetween(key, null);
      insert.run(`rec_${String(i).padStart(5, "0")}`, database.id, key, JSON.stringify({
        [title.id]: i % 13 ? "other" : "needle", [number.id]: i % 17,
      }));
    }
  })();
  return { db, service, database, props: [title, number], title, number };
}
function readOnly(db: Database, reads: string[]): DbDriver {
  return {
    query(sql) { reads.push(sql); return db.query(sql); },
    exec() { throw new Error("read query attempted DDL or a write"); },
    transaction() { throw new Error("read query attempted a transaction"); },
  };
}

test("fresh schema indexes manual pages before records exist; 10k long-key pages stay read-only", async () => {
  const f = fixture();
  const reads: string[] = [];
  const driver = readOnly(f.db, reads);
  const version = f.db.query("PRAGMA schema_version").get();
  const plan = f.db.query("EXPLAIN QUERY PLAN SELECT id,database_id,data FROM records WHERE database_id = ? AND __deleted = 0 ORDER BY order_key IS NULL,order_key,id LIMIT ? OFFSET ?").all(f.database.id, 200, 0) as { detail: string }[];
  expect(plan.some(row => row.detail.includes("idx_mobile_record_page"))).toBe(true);
  expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
  const ids: string[] = [];
  for (let offset = 0; offset < 10000; offset += 200) {
    const page = await queryRecordsAsync(driver, f.database.id, { offset, limit: 200 });
    expect(page.total).toBe(10000);
    expect(page.hasMore).toBe(offset < 9800);
    ids.push(...page.records.map(record => record.id));
  }
  expect(ids).toEqual(Array.from({ length: 10000 }, (_, i) => `rec_${String(i).padStart(5, "0")}`));
  expect(f.db.query("PRAGMA schema_version").get()).toEqual(version);
  expect(reads.every(sql => /^SELECT/.test(sql))).toBe(true);
});

test("filtered async first turn touches no SQLite, and cancellation works before scanning", async () => {
  const f = fixture(1000);
  const reads: string[] = [];
  let current = true;
  const pending = queryRecordsAsync(readOnly(f.db, reads), f.database.id, { search: "needle", sort: [{ prop: f.number.id, desc: true }] }, () => current);
  expect(reads).toEqual([]);
  current = false;
  await expect(pending).rejects.toThrow("Replica query cancelled");
  expect(reads).toEqual([]);
});

test("bounded async scans retain full-set filter, search and stable multi-key sort semantics", async () => {
  const f = fixture();
  f.db.query("UPDATE records SET order_key = NULL WHERE id = 'rec_00000'").run();
  f.db.query("UPDATE records SET __deleted = 1 WHERE id = 'rec_00013'").run();
  const query = {
    search: "needle", filter: { op: "or" as const, rules: [{ id: "n", prop: f.number.id, cond: "gt", value: 6 }] },
    sort: [{ prop: f.number.id, desc: true }, { prop: f.title.id, desc: false }], offset: 100, limit: 200,
  };
  const all = applySort(applyFilter(searchRecords(listRecords(f.db, f.database.id), f.props, query.search), f.props, query.filter), f.props, query.sort);
  let turns = 0;
  const timer = setInterval(() => turns++, 0);
  try {
    const page = await queryRecordsAsync(readOnly(f.db, []), f.database.id, query);
    expect(page.records).toEqual(all.slice(100, 300));
    expect(page.total).toBe(all.length);
    expect(page.hasMore).toBe(all.length > 300);
    expect(turns).toBeGreaterThan(2);
  } finally { clearInterval(timer); }
});

test("queryRecords never installs an index even on a schema-only caller", () => {
  const db = new Database(":memory:"); handles.push(db); runSchema(db);
  const version = db.query("PRAGMA schema_version").get();
  expect(queryRecords(readOnly(db, []), "missing").records).toEqual([]);
  expect(db.query("PRAGMA schema_version").get()).toEqual(version);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'idx_mobile_record_page'").get()).toBeNull();
});

test("record migration upgrades missing order_key before creating its index and is idempotent", () => {
  const db = new Database(":memory:"); handles.push(db);
  db.exec("CREATE TABLE records(id TEXT PRIMARY KEY,database_id TEXT,created_hlc TEXT,__deleted INTEGER NOT NULL DEFAULT 0); CREATE TABLE record_values(record_id TEXT,property_id TEXT,value TEXT); INSERT INTO records(id,database_id,created_hlc) VALUES('r','d','1'); INSERT INTO record_values VALUES('r','p','42');");
  migrateRecords(db);
  const row = db.query("SELECT * FROM records").get();
  expect(row).toMatchObject({ id: "r", database_id: "d", data: '{"p":42}' });
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'idx_mobile_record_page'").get()).not.toBeNull();
  const version = db.query("PRAGMA schema_version").get();
  migrateRecords(db);
  expect(db.query("SELECT * FROM records").get()).toEqual(row);
  expect(db.query("PRAGMA schema_version").get()).toEqual(version);
});

test("populated database migration builds the index once without changing rows or replication history", () => {
  const f = fixture(1000);
  f.db.exec("DROP INDEX idx_mobile_record_page");
  const rows = f.db.query("SELECT * FROM records ORDER BY id").all();
  const changes = f.db.query("SELECT * FROM crdt_changes ORDER BY seq").all();
  initSchema(f.db);
  expect(f.db.query("SELECT * FROM records ORDER BY id").all()).toEqual(rows);
  expect(f.db.query("SELECT * FROM crdt_changes ORDER BY seq").all()).toEqual(changes);
  const version = f.db.query("PRAGMA schema_version").get();
  initSchema(f.db);
  expect(f.db.query("PRAGMA schema_version").get()).toEqual(version);
});
