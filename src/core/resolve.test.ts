import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import { createDatabase } from "./databases.ts";
import { addProperty } from "./properties.ts";
import { createRecord } from "./records.ts";
import { createDocument } from "./documents.ts";
import { emit } from "./crdt.ts";
import { resolveRef, resolveCandidates, resolveEntity } from "./resolve.ts";
import { newId, idKind } from "./ids.ts";

function newDb(node = "test-node"): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(node);
  return db;
}

test("newId / idKind round-trip; legacy ids have no kind", () => {
  const id = newId("rec", "Fix Login Bug");
  expect(id.startsWith("rec_fix-login-bug-")).toBe(true);
  expect(idKind(id)).toBe("rec");
  expect(idKind("tasks-a3f9")).toBeNull(); // legacy (no underscore)
  expect(idKind("nope_x")).toBeNull(); // unknown prefix
});

test("exact full id always resolves, scoped to its kind", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  expect(resolveRef(db, d.id, { kind: "db" })).toBe(d.id);
  expect(resolveRef(db, d.id)).toBe(d.id); // generic
});

test("resolve by name (db/doc) and by bare slug prefix (any kind)", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  addProperty(db, d.id, { name: "title", type: "text" });
  const r = createRecord(db, d.id, { title: "Fix login bug" });
  const doc = createDocument(db, { title: "Design Notes" });

  expect(resolveRef(db, "tasks", { kind: "db" })).toBe(d.id); // name
  expect(resolveRef(db, "TASKS", { kind: "db" })).toBe(d.id); // case-insensitive
  expect(resolveRef(db, "fix-login", { kind: "rec" })).toBe(r.id); // bare slug -> rec_…
  expect(resolveRef(db, "design notes", { kind: "doc" })).toBe(doc.id); // title
});

test("unique id-prefix resolves; ambiguous prefix throws with candidates", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  addProperty(db, d.id, { name: "title", type: "text" });
  const a = createRecord(db, d.id, { title: "Fix login bug" });
  createRecord(db, d.id, { title: "Fix logout bug" });

  expect(resolveRef(db, "rec_fix-login", { kind: "rec" })).toBe(a.id);
  expect(() => resolveRef(db, "fix", { kind: "rec" })).toThrow(/ambiguous/);
  expect(() => resolveRef(db, "nope", { kind: "rec" })).toThrow(/no such record/);
});

test("generic resolve dispatches by type prefix and across kinds", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  const doc = createDocument(db, { title: "Tasks" }); // same name, different kind

  // typed prefix dispatches to the right kind even when names collide
  expect(resolveEntity(db, doc.id).kind).toBe("doc");
  expect(resolveEntity(db, d.id).kind).toBe("db");
  // bare name "tasks" now matches both a db and a doc -> ambiguous
  expect(() => resolveRef(db, "tasks")).toThrow(/ambiguous/);
});

test("databaseId scope narrows record candidates", () => {
  const db = newDb();
  const a = createDatabase(db, { name: "A" });
  const b = createDatabase(db, { name: "B" });
  addProperty(db, a.id, { name: "title", type: "text" });
  addProperty(db, b.id, { name: "title", type: "text" });
  const ra = createRecord(db, a.id, { title: "Shared name" });
  createRecord(db, b.id, { title: "Shared name" });

  // unscoped: two "shared-name" records -> ambiguous
  expect(() => resolveRef(db, "shared-name", { kind: "rec" })).toThrow(/ambiguous/);
  // scoped to A: unique
  expect(resolveRef(db, "shared-name", { kind: "rec", databaseId: a.id })).toBe(ra.id);
});

test("blk is excluded from public resolution", () => {
  const db = newDb();
  const doc = createDocument(db, { title: "Doc", body: "hello world" });
  const blk = db.query("SELECT id FROM doc_blocks WHERE doc_id = ?").get(doc.id) as {
    id: string;
  };
  expect(idKind(blk.id)).toBe("blk");
  // generic resolve never returns the block, even by its full id
  expect(() => resolveRef(db, blk.id)).toThrow(/no such/);
  expect(resolveCandidates(db, blk.id)).toHaveLength(0);
});

test("legacy prefix-less ids still resolve by exact match", () => {
  const db = newDb();
  // simulate a pre-prefix database row written straight to the oplog
  emit(db, "databases", "tasks-legacy1", "name", "Legacy");
  expect(resolveRef(db, "tasks-legacy1", { kind: "db" })).toBe("tasks-legacy1");
  expect(resolveRef(db, "tasks-legacy1")).toBe("tasks-legacy1"); // generic
});
