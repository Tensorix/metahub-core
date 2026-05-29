import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import { emit, emitFields, ingest, changesSince } from "./crdt.ts";
import { nextHlc } from "./hlc.ts";

function makeNode(id: string): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return db;
}

// records.data (JSON) holds the field cells record_values used to. Two
// converged nodes hold identical values, but json_set inserts keys in apply
// order, so byte-order can differ — normalize keys before comparing logical state.
function normalizeRecords(rows: any[]) {
  return rows.map((r) => ({
    ...r,
    data: JSON.stringify(
      Object.fromEntries(Object.entries(JSON.parse(r.data || "{}")).sort()),
    ),
  }));
}

function snapshot(db: Database) {
  return {
    databases: db.query("SELECT * FROM databases ORDER BY id").all(),
    records: normalizeRecords(db.query("SELECT * FROM records ORDER BY id").all()),
    documents: db.query("SELECT * FROM documents ORDER BY id").all(),
  };
}

test("hlc is monotonic and totally ordered", () => {
  const db = makeNode("nodea");
  let prev = "";
  for (let i = 0; i < 2000; i++) {
    const h = nextHlc(db, "nodea");
    expect(h > prev).toBe(true);
    prev = h;
  }
});

test("two nodes converge after exchanging changes (incl. concurrent edit)", () => {
  const a = makeNode("aaaa");
  const b = makeNode("bbbb");

  emit(a, "databases", "tasks-1", "name", "Tasks");
  emitFields(a, "records", "rec-1", {
    database_id: "tasks-1",
    "title-x": "write docs",
    "status-y": "todo",
  });

  emit(b, "documents", "doc-1", "title", "Arch");
  emit(b, "documents", "doc-1", "body", "# Arch\n");
  emit(b, "records", "rec-1", "status-y", "done"); // concurrent with A's "todo"

  ingest(b, changesSince(a, ""));
  ingest(a, changesSince(b, ""));

  expect(snapshot(a)).toEqual(snapshot(b));

  // re-ingesting is a no-op (idempotent)
  const before = snapshot(a);
  ingest(a, changesSince(b, ""));
  expect(snapshot(a)).toEqual(before);
});

test("apply order does not affect the materialized result", () => {
  const a = makeNode("aaaa");
  emit(a, "databases", "tasks-1", "name", "Tasks");
  emit(a, "databases", "tasks-1", "name", "Tasks Renamed");
  emit(a, "databases", "tasks-1", "icon", "list");
  const all = changesSince(a, "");

  const fwd = makeNode("xxxx");
  ingest(fwd, all);
  const rev = makeNode("yyyy");
  ingest(rev, [...all].reverse());

  expect(snapshot(fwd).databases).toEqual(snapshot(rev).databases);
  expect(snapshot(fwd).databases).toEqual(snapshot(a).databases);
});
