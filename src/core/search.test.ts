import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema, ftsAvailable } from "./db.ts";
import { ingest, type Change } from "./crdt.ts";
import { search, rebuildSearchIndex } from "./search.ts";
import { createDatabase, deleteDatabase } from "./databases.ts";
import { addProperty, updateProperty } from "./properties.ts";
import { createRecord, updateRecord, deleteRecord } from "./records.ts";
import { createDocument, appendDocument } from "./documents.ts";

function makeNode(id = "aaaa"): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return db;
}

/** Set of result ids for a query (FTS or LIKE — both must agree on membership). */
function ids(db: Database, q: string): Set<string> {
  return new Set(search(db, q).map((h) => h.id));
}

function withTextDb(db: Database): { dbId: string; propId: string } {
  const d = createDatabase(db, { name: "Notes" });
  const p = addProperty(db, d.id, { name: "Body", type: "text" });
  return { dbId: d.id, propId: p.id };
}

test("indexes documents and records for basic search", () => {
  const db = makeNode();
  const doc = createDocument(db, { title: "Greetings", body: "hello alpha world" });
  const { dbId, propId: _propId } = withTextDb(db);
  const rec = createRecord(db, dbId, { Body: "hello beta" });

  expect(ids(db, "alpha").has(doc.id)).toBe(true);
  expect(ids(db, "beta").has(rec.id)).toBe(true);
  expect(ids(db, "hello")).toEqual(new Set([doc.id, rec.id]));
});

test("incremental edit updates one record without dropping others", () => {
  const db = makeNode();
  const { dbId } = withTextDb(db);
  // Seed with neutral values: the record id is derived from its first text value
  // and is itself indexed (as the FTS title), so the searched tokens below must
  // live only in the body, never in the id slug.
  const r1 = createRecord(db, dbId, { Body: "seedaaa" });
  const r2 = createRecord(db, dbId, { Body: "seedbbb" });
  updateRecord(db, r1.id, { Body: "topic uno" });
  updateRecord(db, r2.id, { Body: "topic dos" });
  expect(ids(db, "topic")).toEqual(new Set([r1.id, r2.id])); // establishes the cursor

  updateRecord(db, r1.id, { Body: "topic edited" });
  expect(ids(db, "topic")).toEqual(new Set([r1.id, r2.id])); // r2 not dropped
  expect(ids(db, "edited")).toEqual(new Set([r1.id]));
  expect(ids(db, "uno")).toEqual(new Set()); // old value gone
  expect(ids(db, "dos")).toEqual(new Set([r2.id])); // r2 untouched
});

// Regression: a remote write carrying an HLC smaller than the local max must
// still be indexed. The old MAX(hlc) heuristic missed it (max didn't move); the
// rowid cursor sees every inserted change in insertion order.
test("out-of-order remote change with a smaller HLC is still indexed", () => {
  const db = makeNode("local");
  const { dbId, propId } = withTextDb(db);
  const local = createRecord(db, dbId, { Body: "phrase local" }); // pushes HLC far forward
  expect(ids(db, "phrase")).toEqual(new Set([local.id])); // sets cursor at oplog head

  const remote: Change[] = [
    { hlc: "000000000000001-0000-remote", node_id: "remote", dataset: "records", row_id: "rec_remote", col: "database_id", value: JSON.stringify(dbId) },
    { hlc: "000000000000002-0000-remote", node_id: "remote", dataset: "records", row_id: "rec_remote", col: propId, value: JSON.stringify("phrase remote") },
  ];
  ingest(db, remote); // smaller HLC than local max, but new rowids > cursor

  expect(ids(db, "phrase")).toEqual(new Set([local.id, "rec_remote"]));
});

test("editing document blocks reindexes the document", () => {
  const db = makeNode();
  const doc = createDocument(db, { title: "Note", body: "alpha block" });
  expect(ids(db, "alpha")).toEqual(new Set([doc.id]));

  appendDocument(db, doc.id, "beta block");
  expect(ids(db, "beta")).toEqual(new Set([doc.id])); // new block content indexed
  expect(ids(db, "alpha")).toEqual(new Set([doc.id])); // original still there
});

test("changing a property type removes its text from the index", () => {
  const db = makeNode();
  const { dbId, propId } = withTextDb(db);
  const rec = createRecord(db, dbId, { Body: "searchme" });
  expect(ids(db, "searchme")).toEqual(new Set([rec.id]));

  updateProperty(db, propId, { type: "number" }); // text no longer contributes
  expect(ids(db, "searchme")).toEqual(new Set());
});

test("soft-deleting a record removes it from search", () => {
  const db = makeNode();
  const { dbId } = withTextDb(db);
  const rec = createRecord(db, dbId, { Body: "deleteme" });
  expect(ids(db, "deleteme")).toEqual(new Set([rec.id]));

  deleteRecord(db, rec.id);
  expect(ids(db, "deleteme")).toEqual(new Set());
});

test("bumping the index version forces a full rebuild", () => {
  const db = makeNode();
  const { dbId } = withTextDb(db);
  const rec = createRecord(db, dbId, { Body: "rebuildme" });
  expect(ids(db, "rebuildme")).toEqual(new Set([rec.id])); // builds at version 1

  // Simulate an upgrade that changed indexing logic.
  db.query("UPDATE meta SET value = '999' WHERE key = 'search_index_version'").run();
  expect(ids(db, "rebuildme")).toEqual(new Set([rec.id])); // still correct after rebuild

  if (ftsAvailable(db)) {
    const v = db.query("SELECT value FROM meta WHERE key = 'search_index_version'").get() as { value: string };
    expect(v.value).toBe("1"); // full rebuild reset the version
  }
});

test("deleting a database removes its records from search (cascade routing)", () => {
  const db = makeNode();
  const { dbId } = withTextDb(db);
  const rec = createRecord(db, dbId, { Body: "doomed" });
  expect(ids(db, "doomed")).toEqual(new Set([rec.id]));

  deleteDatabase(db, dbId); // cascades records.__deleted = 1
  expect(ids(db, "doomed")).toEqual(new Set());
});

test("rebuildSearchIndex rebuilds the index from scratch", () => {
  const db = makeNode();
  const { dbId } = withTextDb(db);
  const rec = createRecord(db, dbId, { Body: "rebuilt" });
  expect(ids(db, "rebuilt")).toEqual(new Set([rec.id]));

  if (ftsAvailable(db)) {
    db.query("DELETE FROM search_fts").run(); // corrupt the index
    rebuildSearchIndex(db);
  }
  expect(ids(db, "rebuilt")).toEqual(new Set([rec.id]));
});
