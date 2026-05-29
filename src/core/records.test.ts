import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema, migrateRecords } from "./db.ts";
import { createDatabase } from "./databases.ts";
import { addProperty } from "./properties.ts";
import {
  createRecord,
  getRecord,
  listRecords,
  updateRecord,
  deleteRecord,
} from "./records.ts";
import { hasIndex } from "./indexing.ts";
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

  // idempotent: running again is a no-op
  migrateRecords(db);
  expect(JSON.parse((db.query("SELECT data FROM records WHERE id='r2'").get() as any).data)).toEqual(
    { "p-title": "world" },
  );
});
