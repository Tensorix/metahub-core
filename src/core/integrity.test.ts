import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import { emit, ingest, changesSince } from "./crdt.ts";
import { validateHub, repairHub } from "./integrity.ts";
import { createDatabase, deleteDatabase } from "./databases.ts";
import { addProperty, removeProperty } from "./properties.ts";
import { createRecord, getRecord } from "./records.ts";
import { createDocument, deleteDocument, getDocument } from "./documents.ts";
import { createSite, deleteSite, putFile, getFileForServe } from "./sites.ts";

function makeNode(id: string): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return db;
}

function normalizeRecords(rows: any[]) {
  return rows.map((r) => ({
    ...r,
    data: JSON.stringify(
      Object.fromEntries(Object.entries(JSON.parse(r.data || "{}")).sort()),
    ),
  }));
}

function fullSnapshot(db: Database) {
  return {
    databases: db.query("SELECT * FROM databases ORDER BY id").all(),
    properties: db.query("SELECT * FROM properties ORDER BY id").all(),
    records: normalizeRecords(db.query("SELECT * FROM records ORDER BY id").all()),
    documents: db.query("SELECT * FROM documents ORDER BY id").all(),
    doc_blocks: db.query("SELECT * FROM doc_blocks ORDER BY id").all(),
    site_files: db.query("SELECT * FROM site_files ORDER BY id").all(),
  };
}

function sync(a: Database, b: Database): void {
  ingest(b, changesSince(a, ""));
  ingest(a, changesSince(b, ""));
}

// --- principle 1: act on tombstones, tolerate absence -----------------------

test("out-of-order forward reference is not destroyed by repair", () => {
  // A child document arrives (parent_id) before its parent exists. Repairing
  // mid-flight must NOT unparent it; once the parent arrives the link holds.
  const db = makeNode("aaaa");
  emit(db, "documents", "doc_child", "title", "Child");
  emit(db, "documents", "doc_child", "created_hlc", "001");
  emit(db, "documents", "doc_child", "parent_id", "doc_parent"); // parent not yet present

  // Parent is merely absent (no tombstone) -> tolerated, no repair.
  expect(validateHub(db).ok).toBe(true);
  expect(repairHub(db).applied).toBe(0);
  expect(getDocument(db, "doc_child")?.parent_id).toBe("doc_parent");

  // Parent arrives; relationship is intact.
  emit(db, "documents", "doc_parent", "title", "Parent");
  emit(db, "documents", "doc_parent", "created_hlc", "002");
  expect(validateHub(db).ok).toBe(true);
  expect(getDocument(db, "doc_child")?.parent_id).toBe("doc_parent");
});

test("repair acts once a target is tombstoned (not merely absent)", () => {
  const db = makeNode("aaaa");
  const parent = createDocument(db, { title: "Parent" });
  const child = createDocument(db, { title: "Child", parent_id: parent.id });

  expect(validateHub(db).ok).toBe(true);

  // Tombstone the parent directly (simulating a delete that didn't cascade,
  // e.g. arriving via sync). Now the child's parent_id is genuinely broken.
  emit(db, "documents", parent.id, "__deleted", 1);
  const before = validateHub(db);
  expect(before.counts.broken_ref).toBe(1);

  const res = repairHub(db);
  expect(res.applied).toBe(1);
  expect(getDocument(db, child.id)?.parent_id).toBeNull(); // unparented, survives
  expect(validateHub(db).ok).toBe(true);
});

// --- write-time cascades ----------------------------------------------------

test("deleteDatabase cascades: properties/records tombstoned, documents detached", () => {
  const db = makeNode("aaaa");
  const d = createDatabase(db, { name: "Tasks" });
  addProperty(db, d.id, { name: "status", type: "text" });
  const rec = createRecord(db, d.id, { status: "todo" });
  const doc = createDocument(db, { title: "Spec", database_id: d.id });

  deleteDatabase(db, d.id);

  // No dangling live rows pointing at the deleted database.
  expect(validateHub(db).ok).toBe(true);
  expect(getRecord(db, rec.id)).toBeNull(); // record tombstoned
  expect(getDocument(db, doc.id)?.database_id).toBeNull(); // doc detached, survives
});

test("removeProperty clears orphaned cells", () => {
  const db = makeNode("aaaa");
  const d = createDatabase(db, { name: "Tasks" });
  const p = addProperty(db, d.id, { name: "status", type: "text" });
  const rec = createRecord(db, d.id, { status: "todo" });

  removeProperty(db, p.id);

  // The cell keyed by the removed property id is gone from the JSON.
  const raw = db.query("SELECT data FROM records WHERE id = ?").get(rec.id) as { data: string };
  expect(JSON.parse(raw.data)[p.id]).toBeUndefined();
  expect(validateHub(db).ok).toBe(true);
});

test("deleteDocument cascades blocks and unparents children", () => {
  const db = makeNode("aaaa");
  const parent = createDocument(db, { title: "Parent", body: "hello\n\nworld" });
  const child = createDocument(db, { title: "Child", parent_id: parent.id });

  deleteDocument(db, parent.id);

  expect(validateHub(db).ok).toBe(true);
  expect(getDocument(db, child.id)?.parent_id).toBeNull();
  const liveBlocks = db
    .query("SELECT count(*) AS c FROM doc_blocks WHERE doc_id = ? AND __deleted = 0")
    .get(parent.id) as { c: number };
  expect(liveBlocks.c).toBe(0);
});

// --- orphan cells off a tombstoned property (no write-time cascade) ---------

test("repair removes orphan cells left by a tombstoned property", () => {
  const db = makeNode("aaaa");
  const d = createDatabase(db, { name: "Tasks" });
  const p = addProperty(db, d.id, { name: "status", type: "text" });
  const rec = createRecord(db, d.id, { status: "todo" });

  // Tombstone the property directly (bypassing removeProperty's cell cleanup),
  // as would happen if the tombstone arrived over sync.
  emit(db, "properties", p.id, "__deleted", 1);
  expect(validateHub(db).counts.orphan_cell).toBe(1);

  repairHub(db);
  const raw = db.query("SELECT data FROM records WHERE id = ?").get(rec.id) as { data: string };
  expect(JSON.parse(raw.data)[p.id]).toBeUndefined();
  expect(validateHub(db).ok).toBe(true);
});

// --- determinism / fixpoint -------------------------------------------------

test("two divergent nodes converge AND are valid after independent repair", () => {
  // A deletes a database; B concurrently inserts a record into it.
  const a = makeNode("aaaa");
  const b = makeNode("bbbb");
  const d = createDatabase(a, { name: "Tasks" });
  addProperty(a, d.id, { name: "status", type: "text" });
  sync(a, b);

  deleteDatabase(a, d.id); // A removes the database
  const orphan = createRecord(b, d.id, { status: "todo" }); // B races a new record in

  sync(a, b);
  // Each node repairs independently off the converged state.
  repairHub(a);
  repairHub(b);
  sync(a, b);

  expect(fullSnapshot(a)).toEqual(fullSnapshot(b));
  expect(validateHub(a).ok).toBe(true);
  expect(validateHub(b).ok).toBe(true);
  expect(getRecord(a, orphan.id)).toBeNull(); // orphan cleaned on both
});

test("repair is idempotent (fixpoint): second run is a no-op", () => {
  const db = makeNode("aaaa");
  const d = createDatabase(db, { name: "Tasks" });
  const p = addProperty(db, d.id, { name: "status", type: "text" });
  createRecord(db, d.id, { status: "todo" });
  emit(db, "databases", d.id, "__deleted", 1); // tombstone without cascade

  const first = repairHub(db);
  expect(first.applied).toBeGreaterThan(0);
  expect(first.remaining.ok).toBe(true);

  const second = repairHub(db);
  expect(second.applied).toBe(0);
});

test("post-sync parent cycle is broken deterministically", () => {
  const a = makeNode("aaaa");
  const b = makeNode("bbbb");
  const x = createDocument(a, { title: "X" });
  const y = createDocument(a, { title: "Y" });
  sync(a, b);

  // Concurrent edits form a cycle: A sets X->Y, B sets Y->X.
  emit(a, "documents", x.id, "parent_id", y.id);
  emit(b, "documents", y.id, "parent_id", x.id);
  sync(a, b);

  expect(validateHub(a).counts.parent_cycle).toBe(1);
  repairHub(a);
  repairHub(b);
  sync(a, b);

  expect(validateHub(a).ok).toBe(true);
  expect(fullSnapshot(a)).toEqual(fullSnapshot(b));
});

// --- route dedup vs. report-only --------------------------------------------

test("duplicate file paths dedup to the read winner; site name dup is report-only", async () => {
  const a = makeNode("aaaa");
  const b = makeNode("bbbb");
  const s = createSite(a, { name: "blog" });
  sync(a, b);

  // Concurrent uploads to the same path on both nodes -> two file rows.
  await putFile(a, s.id, "index.html", { data: "<h1>A</h1>" });
  await putFile(b, s.id, "index.html", { data: "<h1>B</h1>" });
  sync(a, b);

  const liveBefore = a
    .query("SELECT count(*) AS c FROM site_files WHERE site_id = ? AND path = 'index.html' AND __deleted = 0")
    .get(s.id) as { c: number };
  expect(liveBefore.c).toBe(2);
  expect(validateHub(a).counts.dup_path).toBe(1);

  repairHub(a);
  repairHub(b);
  sync(a, b);

  const liveAfter = a
    .query("SELECT count(*) AS c FROM site_files WHERE site_id = ? AND path = 'index.html' AND __deleted = 0")
    .get(s.id) as { c: number };
  expect(liveAfter.c).toBe(1);
  expect(await getFileForServe(a, s.id, "index.html")).not.toBeNull();
  expect(fullSnapshot(a)).toEqual(fullSnapshot(b));
});

test("duplicate database names are reported, not modified", () => {
  const db = makeNode("aaaa");
  createDatabase(db, { name: "Tasks" });
  createDatabase(db, { name: "Tasks" }); // distinct ids, same name

  const report = validateHub(db);
  expect(report.counts.dup_name).toBe(1);
  // Report-only: repair leaves both live.
  repairHub(db);
  const live = db.query("SELECT count(*) AS c FROM databases WHERE __deleted = 0").get() as { c: number };
  expect(live.c).toBe(2);
});

test("invalid property config is reported", () => {
  const db = makeNode("aaaa");
  const d = createDatabase(db, { name: "Tasks" });
  // Emit a relation property with no config.database, bypassing addProperty's guard.
  emit(db, "properties", "prop_bad", "database_id", d.id);
  emit(db, "properties", "prop_bad", "name", "rel");
  emit(db, "properties", "prop_bad", "type", "relation");
  emit(db, "properties", "prop_bad", "position", 1);

  expect(validateHub(db).counts.bad_config).toBe(1);
});

test("a healthy hub reports clean and repairs to a no-op", () => {
  const db = makeNode("aaaa");
  const d = createDatabase(db, { name: "Tasks" });
  addProperty(db, d.id, { name: "status", type: "select", config: { options: ["todo", "done"] } });
  createRecord(db, d.id, { status: "todo" });
  createDocument(db, { title: "Spec", body: "hi" });

  expect(validateHub(db).ok).toBe(true);
  expect(repairHub(db).applied).toBe(0);
});

// --- dead cell references (relation/doc arrays) -----------------------------

test("dead_cell_ref strips tombstoned targets from relation and doc cells", () => {
  const db = makeNode("aaaa");
  const people = createDatabase(db, { name: "People" });
  addProperty(db, people.id, { name: "Name", type: "text" });
  const tasks = createDatabase(db, { name: "Tasks" });
  addProperty(db, tasks.id, { name: "Title", type: "text" });
  const rel = addProperty(db, tasks.id, { name: "Owner", type: "relation", config: { database: people.id } });
  const docs = addProperty(db, tasks.id, { name: "Docs", type: "doc" });

  const alice = createRecord(db, people.id, { Name: "Alice" });
  const bob = createRecord(db, people.id, { Name: "Bob" });
  const spec = createDocument(db, { title: "Spec" });
  const notes = createDocument(db, { title: "Notes" });
  const t = createRecord(db, tasks.id, {
    Title: "ship",
    Owner: [alice.id, bob.id],
    Docs: [spec.id, notes.id],
  });

  // delete one target of each kind
  emit(db, "records", bob.id, "__deleted", 1);
  deleteDocument(db, notes.id);

  const report = validateHub(db);
  expect(report.counts["dead_cell_ref"]).toBe(2);

  const res = repairHub(db);
  expect(res.fixed["dead_cell_ref"]).toBe(2);
  const after = getRecord(db, t.id)!;
  expect(after.cells[rel.id]).toEqual([alice.id]); // survivor kept
  expect(after.cells[docs.id]).toEqual([spec.id]);

  // fixpoint: a second repair applies nothing
  expect(repairHub(db).applied).toBe(0);
});

test("dead_cell_ref: forward references to absent targets are tolerated", () => {
  const db = makeNode("aaaa");
  const d = createDatabase(db, { name: "Tasks" });
  const rel = addProperty(db, d.id, { name: "Rel", type: "relation", config: { database: d.id } });
  const docs = addProperty(db, d.id, { name: "Docs", type: "doc" });
  const r = createRecord(db, d.id, {
    Rel: ["rec_future-aaaaaa"],
    Docs: ["doc_future-aaaaaa"],
  });

  // absent (never created) targets are potential in-flight forward references
  expect(validateHub(db).counts["dead_cell_ref"] ?? 0).toBe(0);
  expect(repairHub(db).applied).toBe(0);
  const after = getRecord(db, r.id)!;
  expect(after.cells[rel.id]).toEqual(["rec_future-aaaaaa"]);
  expect(after.cells[docs.id]).toEqual(["doc_future-aaaaaa"]);
});

test("dead_cell_ref: an array losing every element repairs to []", () => {
  const db = makeNode("aaaa");
  const d = createDatabase(db, { name: "Tasks" });
  const docs = addProperty(db, d.id, { name: "Docs", type: "doc" });
  const doc = createDocument(db, { title: "Only" });
  const r = createRecord(db, d.id, { Docs: [doc.id] });
  deleteDocument(db, doc.id);

  repairHub(db);
  expect(getRecord(db, r.id)!.cells[docs.id]).toEqual([]);
  expect(repairHub(db).applied).toBe(0);
});

test("dead_cell_ref repair converges across nodes", () => {
  const a = makeNode("aaaa");
  const d = createDatabase(a, { name: "Tasks" });
  addProperty(a, d.id, { name: "Docs", type: "doc" });
  const doc = createDocument(a, { title: "Shared" });
  createRecord(a, d.id, { Docs: [doc.id] });
  deleteDocument(a, doc.id);

  const b = makeNode("bbbb");
  sync(a, b);
  repairHub(a);
  repairHub(b);
  sync(a, b);
  expect(fullSnapshot(a)).toEqual(fullSnapshot(b));
  expect(repairHub(a).applied).toBe(0);
  expect(repairHub(b).applied).toBe(0);
});
