import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import { emit, emitFields, ingest, changesSince, changesAfterSeq, withNodeId } from "./crdt.ts";
import { nextHlc, parseHlc } from "./hlc.ts";

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

test("withNodeId attributes emits to a guest node id, then restores the host", () => {
  const db = makeNode("hosthost");
  const ch = withNodeId("gguest01", () => emit(db, "documents", "doc_x", "title", "hi"));
  expect(ch.node_id).toBe("gguest01");
  // The HLC node segment carries the guest too (it's threaded through nextHlc).
  expect(parseHlc(ch.hlc).node).toBe("gguest01");
  const row = db
    .query(
      "SELECT node_id FROM crdt_changes WHERE dataset='documents' AND row_id='doc_x' AND col='title'",
    )
    .get() as { node_id: string };
  expect(row.node_id).toBe("gguest01");
  // Outside the override, emits use the host node again.
  expect(emit(db, "documents", "doc_x", "title", "bye").node_id).toBe("hosthost");
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

// changesAfterSeq onlyNode — storage-sync uploads only this node's own ops to
// its bucket prefix (no re-uploading ingested peer ops). See sync/storage.ts.

test("changesAfterSeq onlyNode returns just this node's own ops", () => {
  const a = makeNode("nodeA");
  const b = makeNode("nodeB");
  emit(a, "databases", "db1", "name", "A1");
  emit(a, "databases", "db1", "icon", "📦");
  ingest(a, [emit(b, "databases", "db2", "name", "B1")]);

  expect(changesAfterSeq(a, 0).changes.length).toBe(3); // all three, unfiltered

  const mine = changesAfterSeq(a, 0, { onlyNode: "nodeA" }).changes;
  expect(mine.length).toBe(2);
  expect(mine.every((c) => c.node_id === "nodeA")).toBe(true);
});

test("onlyNode cursor advances past ingested foreign ops so they aren't rescanned", () => {
  const a = makeNode("nodeA");
  const b = makeNode("nodeB");
  emit(a, "databases", "db1", "name", "A1");
  ingest(a, [emit(b, "databases", "db2", "name", "B1")]);

  const batch = changesAfterSeq(a, 0, { onlyNode: "nodeA" });
  expect(batch.changes.length).toBe(1);
  // exhausted scan jumps the cursor to the global high-water rowid, past the
  // ingested foreign row — the next round sees nothing to re-upload.
  expect(changesAfterSeq(a, batch.cursor, { onlyNode: "nodeA" }).changes.length).toBe(0);

  // a fresh self op lands above the cursor and is picked up.
  emit(a, "databases", "db1", "icon", "x");
  const after = changesAfterSeq(a, batch.cursor, { onlyNode: "nodeA" });
  expect(after.changes.length).toBe(1);
  expect(after.changes[0]!.col).toBe("icon");
});

test("onlyNode honors limit and resumes from the last returned row", () => {
  const a = makeNode("nodeA");
  emit(a, "databases", "db1", "name", "1");
  emit(a, "databases", "db1", "icon", "2");
  emit(a, "databases", "db1", "created_hlc", "3");

  const first = changesAfterSeq(a, 0, { onlyNode: "nodeA", limit: 2 });
  expect(first.changes.length).toBe(2);
  const second = changesAfterSeq(a, first.cursor, { onlyNode: "nodeA", limit: 2 });
  expect(second.changes.length).toBe(1);
});
