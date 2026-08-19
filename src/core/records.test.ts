import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema, migrateRecords } from "./db.ts";
import { createDatabase } from "./databases.ts";
import { addProperty } from "./properties.ts";
import {
  createRecord,
  getRecord,
  listRecords,
  moveRecord,
  updateRecord,
  deleteRecord,
} from "./records.ts";
import { hasIndex } from "./indexing.ts";
import { createDocument } from "./documents.ts";
import { emit, ingest, changesSince } from "./crdt.ts";

function newDb(node = "test-node"): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(node);
  return db;
}

test("create / read / update / delete round-trips through data JSON", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  addProperty(db, d.id, { name: "title", type: "text" });
  addProperty(db, d.id, { name: "done", type: "checkbox" });

  const rec = createRecord(db, d.id, { title: "write docs", done: false });
  expect(getRecord(db, rec.id)!.values).toEqual({ title: "write docs", done: false });

  updateRecord(db, rec.id, { done: true });
  expect(getRecord(db, rec.id)!.values.done).toBe(true);

  // data is stored as one JSON row, not EAV cells
  const raw = db.query("SELECT data FROM records WHERE id = ?").get(rec.id) as {
    data: string;
  };
  expect(typeof raw.data).toBe("string");
  expect(Object.keys(JSON.parse(raw.data)).length).toBe(2);

  deleteRecord(db, rec.id);
  expect(getRecord(db, rec.id)).toBeNull();
});

test("explicit null keeps the key as null; a null-valued oplog change removes it", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Notes" });
  const body = addProperty(db, d.id, { name: "body", type: "text" });
  const rec = createRecord(db, d.id, { body: "hello" });

  // Explicit null is a value (matches prior EAV behavior): key present, null.
  updateRecord(db, rec.id, { body: null });
  expect(getRecord(db, rec.id)!.values).toEqual({ body: null });

  // A null-valued change (undefined value -> SQL null in the oplog) removes the
  // key via json_remove — the path sync/forward-compat relies on.
  emit(db, "records", rec.id, body.id, undefined);
  expect(getRecord(db, rec.id)!.values).toEqual({});
  const raw = db.query("SELECT data FROM records WHERE id = ?").get(rec.id) as {
    data: string;
  };
  expect(JSON.parse(raw.data)).toEqual({});
});

test("filter / sort / limit push down to SQL correctly", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Msgs" });
  addProperty(db, d.id, { name: "conversation", type: "text" });
  addProperty(db, d.id, { name: "n", type: "number" });

  for (let i = 0; i < 6; i++)
    createRecord(db, d.id, { conversation: i % 2 ? "b" : "a", n: i });

  // filter
  const a = listRecords(db, d.id, { filter: { conversation: "a" } });
  expect(a.length).toBe(3);
  expect(a.every((r) => r.values.conversation === "a")).toBe(true);

  // sort desc + limit
  const top2 = listRecords(db, d.id, { sort: "-n", limit: 2 });
  expect(top2.map((r) => r.values.n)).toEqual([5, 4]);

  // sort asc
  const asc = listRecords(db, d.id, { sort: "n" });
  expect(asc.map((r) => r.values.n)).toEqual([0, 1, 2, 3, 4, 5]);

  // filter + sort combined
  const aDesc = listRecords(db, d.id, { filter: { conversation: "a" }, sort: "-n" });
  expect(aDesc.map((r) => r.values.n)).toEqual([4, 2, 0]);
});

test("records default to persistent manual order", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  addProperty(db, d.id, { name: "title", type: "text" });
  addProperty(db, d.id, { name: "n", type: "number" });

  const a = createRecord(db, d.id, { title: "a", n: 1 });
  const b = createRecord(db, d.id, { title: "b", n: 2 });
  const c = createRecord(db, d.id, { title: "c", n: 3 });
  expect(listRecords(db, d.id).map((r) => r.id)).toEqual([a.id, b.id, c.id]);

  moveRecord(db, c.id, a.id, "before");
  expect(listRecords(db, d.id).map((r) => r.id)).toEqual([c.id, a.id, b.id]);

  moveRecord(db, a.id, b.id, "after");
  expect(listRecords(db, d.id).map((r) => r.id)).toEqual([c.id, b.id, a.id]);
  expect(listRecords(db, d.id, { sort: "n" }).map((r) => r.id)).toEqual([a.id, b.id, c.id]);
});

test("record moves are scoped to one database and sync via CRDT", () => {
  const a = newDb("aaaa");
  const b = newDb("bbbb");
  const d = createDatabase(a, { name: "Tasks" });
  addProperty(a, d.id, { name: "title", type: "text" });
  const one = createRecord(a, d.id, { title: "one" });
  const two = createRecord(a, d.id, { title: "two" });
  const other = createDatabase(a, { name: "Other" });
  const otherRec = createRecord(a, other.id, {});

  expect(() => moveRecord(a, one.id, otherRec.id, "after")).toThrow(/across databases/);

  ingest(b, changesSince(a, ""));
  moveRecord(a, two.id, one.id, "before");
  ingest(b, changesSince(a, ""));
  expect(listRecords(b, d.id).map((r) => r.id)).toEqual([two.id, one.id]);
});

test("record move rebalances duplicate adjacent order keys", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  addProperty(db, d.id, { name: "title", type: "text" });
  const a = createRecord(db, d.id, { title: "a" });
  const b = createRecord(db, d.id, { title: "b" });
  const c = createRecord(db, d.id, { title: "c" });

  emit(db, "records", a.id, "order_key", "U");
  emit(db, "records", b.id, "order_key", "U");

  expect(() => moveRecord(db, c.id, b.id, "before")).not.toThrow();
  expect(listRecords(db, d.id).map((r) => r.id)).toEqual([a.id, c.id, b.id]);
});

test("concurrent edits to different fields of one record both survive", () => {
  const a = newDb("aaaa");
  const b = newDb("bbbb");

  // same record id on both nodes, different fields
  emit(a, "records", "rec-1", "database_id", "db-1");
  emit(a, "records", "rec-1", "title-x", "from A");
  emit(b, "records", "rec-1", "status-y", "from B");

  ingest(a, changesSince(b, ""));
  ingest(b, changesSince(a, ""));

  const data = (db: Database) =>
    JSON.parse((db.query("SELECT data FROM records WHERE id = 'rec-1'").get() as any).data);
  expect(data(a)).toEqual({ "title-x": "from A", "status-y": "from B" });
  expect(data(a)).toEqual(data(b)); // converged
});

test("relation fields are indexed eagerly", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "People" });
  const friends = addProperty(db, d.id, {
    name: "friends",
    type: "relation",
    config: { database: d.id },
  });
  expect(hasIndex(db, d.id, friends.id)).toBe(true);
});

test("large collection auto-indexes a filtered field and the query uses it", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Big" });
  const conv = addProperty(db, d.id, { name: "conversation", type: "text" });

  for (let i = 0; i < 2001; i++)
    createRecord(db, d.id, { conversation: "c" + (i % 10) });

  expect(hasIndex(db, d.id, conv.id)).toBe(false); // not built until queried
  listRecords(db, d.id, { filter: { conversation: "c1" } });
  expect(hasIndex(db, d.id, conv.id)).toBe(true); // crossed threshold -> built

  const plan = db
    .query(
      `EXPLAIN QUERY PLAN SELECT id FROM records ` +
        `WHERE database_id = ? AND __deleted = 0 AND data ->> '${conv.id}' = ? ` +
        `ORDER BY created_hlc`,
    )
    .all(d.id, "c1") as { detail: string }[];
  expect(plan.some((r) => /USING INDEX/.test(r.detail))).toBe(true);
});

test("migrates legacy record_values into data JSON", () => {
  const db = new Database(":memory:");
  // Recreate the legacy schema shape: records without data + record_values.
  db.exec(`
    CREATE TABLE records (id TEXT PRIMARY KEY, database_id TEXT, created_hlc TEXT, __deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE record_values (record_id TEXT, property_id TEXT, value TEXT, PRIMARY KEY (record_id, property_id));
    INSERT INTO records (id, database_id, created_hlc) VALUES ('r1', 'd1', 'h1'), ('r2', 'd1', 'h2');
    INSERT INTO record_values (record_id, property_id, value) VALUES
      ('r1', 'p-title', '"hello"'), ('r1', 'p-num', '42'), ('r2', 'p-title', '"world"');
  `);

  migrateRecords(db);

  // record_values dropped, data backfilled
  const tbl = db
    .query("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='record_values'")
    .get();
  expect(tbl).toBeNull();
  expect(JSON.parse((db.query("SELECT data FROM records WHERE id='r1'").get() as any).data)).toEqual(
    { "p-title": "hello", "p-num": 42 },
  );
  expect(JSON.parse((db.query("SELECT data FROM records WHERE id='r2'").get() as any).data)).toEqual(
    { "p-title": "world" },
  );
  const order = db
    .query("SELECT id, order_key FROM records ORDER BY order_key, id")
    .all() as { id: string; order_key: string | null }[];
  expect(order.map((r) => r.id)).toEqual(["r1", "r2"]);
  expect(order.every((r) => typeof r.order_key === "string")).toBe(true);

  // idempotent: running again is a no-op
  migrateRecords(db);
  expect(JSON.parse((db.query("SELECT data FROM records WHERE id='r2'").get() as any).data)).toEqual(
    { "p-title": "world" },
  );
});

test("duplicate property names: cells stay id-keyed and lossless; name-keyed access is ambiguous", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "T" });
  const a = addProperty(db, d.id, { name: "日期", type: "date" });
  const rec = createRecord(db, d.id, { 日期: "2026-01-01" });

  // A second property with the same name is legal (offline peers can create
  // duplicates concurrently) and must not alias the first one's cells.
  const b = addProperty(db, d.id, { name: "日期", type: "date" });
  const got = getRecord(db, rec.id)!;
  expect(got.cells[a.id]).toBe("2026-01-01");
  expect(got.cells[b.id]).toBeUndefined();

  // id-keyed writes target exactly the addressed property.
  updateRecord(db, rec.id, { [b.id]: "2027-02-02" });
  const after = getRecord(db, rec.id)!;
  expect(after.cells[a.id]).toBe("2026-01-01");
  expect(after.cells[b.id]).toBe("2027-02-02");

  // name-keyed writes / filters / sorts on the duplicated name must demand an id.
  try {
    updateRecord(db, rec.id, { 日期: "2028-03-03" });
    expect.unreachable("duplicate name write should throw");
  } catch (e) {
    expect((e as { code?: string }).code).toBe("ambiguous");
  }
  expect(() => listRecords(db, d.id, { filter: { 日期: "2026-01-01" } })).toThrow(/use a property id/);
  expect(() => listRecords(db, d.id, { sort: "日期" })).toThrow(/use a property id/);

  // other (unique) names keep working name-keyed.
  addProperty(db, d.id, { name: "备注", type: "text" });
  updateRecord(db, rec.id, { 备注: "ok" });
  expect(getRecord(db, rec.id)!.values["备注"]).toBe("ok");
});

test("doc cells resolve by full id, unique prefix, and title", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  const ref = addProperty(db, d.id, { name: "参考文档", type: "doc" });
  const doc = createDocument(db, { title: "设计说明" });

  // full id
  const r1 = createRecord(db, d.id, { 参考文档: doc.id });
  expect(getRecord(db, r1.id)!.cells[ref.id]).toEqual([doc.id]);

  // title
  const r2 = createRecord(db, d.id, { 参考文档: "设计说明" });
  expect(getRecord(db, r2.id)!.cells[ref.id]).toEqual([doc.id]);

  // unique id prefix
  const prefix = doc.id.slice(0, doc.id.length - 2);
  const r3 = createRecord(db, d.id, { 参考文档: prefix });
  expect(getRecord(db, r3.id)!.cells[ref.id]).toEqual([doc.id]);

  // scalar wraps into an array; null clears to []
  updateRecord(db, r1.id, { 参考文档: null });
  expect(getRecord(db, r1.id)!.cells[ref.id]).toEqual([]);
});

test("doc cells: forward reference passes, unknown title and ambiguity throw", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  const ref = addProperty(db, d.id, { name: "docs", type: "doc" });

  // well-formed doc id that doesn't exist yet passes through (forward reference)
  const r = createRecord(db, d.id, { docs: ["doc_notyet-abc123"] });
  expect(getRecord(db, r.id)!.cells[ref.id]).toEqual(["doc_notyet-abc123"]);

  // a non-id reference matching nothing throws not_found
  try {
    createRecord(db, d.id, { docs: "没有这篇" });
    expect.unreachable("unknown doc title should throw");
  } catch (e) {
    expect((e as { code?: string }).code).toBe("not_found");
  }

  // two documents with the same title → ambiguous
  createDocument(db, { title: "周报" });
  createDocument(db, { title: "周报" });
  try {
    createRecord(db, d.id, { docs: "周报" });
    expect.unreachable("ambiguous doc title should throw");
  } catch (e) {
    expect((e as { code?: string }).code).toBe("ambiguous");
  }
});

test("doc fields are indexed eagerly", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  const p = addProperty(db, d.id, { name: "docs", type: "doc" });
  expect(hasIndex(db, d.id, p.id)).toBe(true);
});
