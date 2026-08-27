import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import { setActorTag } from "./crdt.ts";
import { parseTxn } from "./history.ts";
import { createDatabase } from "./databases.ts";
import { addProperty } from "./properties.ts";
import { createRecord, getRecord, updateRecord, deleteRecord } from "./records.ts";
import { createDocument, getDocument, updateDocument } from "./documents.ts";
import { listAuditEntries, auditEntryDetail, revertChangeGroup } from "./audit.ts";

function makeNode(id: string): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return db;
}

function lastTxn(db: Database): string {
  const row = db
    .query("SELECT txn FROM crdt_changes WHERE txn IS NOT NULL ORDER BY hlc DESC LIMIT 1")
    .get() as { txn: string };
  return row.txn;
}

function oplogCount(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM crdt_changes").get() as { n: number }).n;
}

// The actor slot is process-global — never leak a tag into other test files.
afterEach(() => setActorTag(null));

// ---- txn grammar -------------------------------------------------------------

test("parseTxn splits actor and kind segments", () => {
  expect(parseTxn(null)).toEqual({ actor: null, kind: "user" });
  expect(parseTxn("abc12345")).toEqual({ actor: null, kind: "user" });
  expect(parseTxn("revert:abc12345")).toEqual({ actor: null, kind: "revert" });
  expect(parseTxn("repair:abc12345")).toEqual({ actor: null, kind: "repair" });
  expect(parseTxn("ai/abc12345")).toEqual({ actor: "ai", kind: "user" });
  expect(parseTxn("ai/revert:abc12345")).toEqual({ actor: "ai", kind: "revert" });
  expect(parseTxn("ai/repair:abc12345")).toEqual({ actor: "ai", kind: "repair" });
});

test("setActorTag stamps minted txns; invalid tags throw", () => {
  const db = makeNode("nodeA");
  setActorTag("ai");
  const d = createDatabase(db, { name: "t" });
  expect(lastTxn(db)).toMatch(/^ai\//);
  setActorTag(null);
  addProperty(db, d.id, { name: "x", type: "text" });
  expect(lastTxn(db)).not.toMatch(/^ai\//);
  expect(() => setActorTag("has/slash")).toThrow();
  expect(() => setActorTag("UPPER")).toThrow();
});

// ---- audit feed --------------------------------------------------------------

function seed(db: Database) {
  const d = createDatabase(db, { name: "tasks" });
  const title = addProperty(db, d.id, { name: "title", type: "text" });
  const rec = createRecord(db, d.id, { title: "Buy milk" });
  return { d, title, rec };
}

test("listAuditEntries groups by txn, resolves entities, filters by actor", () => {
  const db = makeNode("nodeA");
  const { d, rec } = seed(db);
  setActorTag("ai");
  updateRecord(db, rec.id, { title: "Buy oat milk" });

  const page = listAuditEntries(db);
  // newest first: the ai update leads
  expect(page.entries[0]!.actor).toBe("ai");
  expect(page.entries[0]!.kind).toBe("user");
  expect(page.entries[0]!.entities).toEqual([
    expect.objectContaining({
      dataset: "records",
      id: rec.id,
      label: "Buy oat milk",
      database_id: d.id,
      database_label: "tasks",
      fields: 1,
    }),
  ]);
  // untagged seeding entries carry no actor; creation flags are set
  const created = page.entries.find((e) => e.entities[0]?.created && e.entities[0]?.dataset === "records");
  expect(created).toBeDefined();
  expect(created!.actor).toBeNull();
  const prop = page.entries.find((e) => e.entities[0]?.dataset === "properties");
  expect(prop!.entities[0]!.created).toBe(true);

  // actor narrow: only the tagged entry remains
  const ai = listAuditEntries(db, { actor: "ai" });
  expect(ai.entries.length).toBe(1);
  expect(ai.entries[0]!.txn).toMatch(/^ai\//);
  expect(() => listAuditEntries(db, { actor: "bad%like" })).toThrow();
});

test("pagination pages older entries via the next cursor", () => {
  const db = makeNode("nodeA");
  const { rec } = seed(db);
  for (let i = 0; i < 5; i++) updateRecord(db, rec.id, { title: `v${i}` });
  const p1 = listAuditEntries(db, { limit: 2 });
  expect(p1.entries.length).toBe(2);
  expect(p1.next).not.toBeNull();
  const p2 = listAuditEntries(db, { limit: 100, before: p1.next! });
  // no overlap, strictly older
  const versions1 = new Set(p1.entries.map((e) => e.version));
  for (const e of p2.entries) {
    expect(versions1.has(e.version)).toBe(false);
    expect(e.version < p1.entries[1]!.version).toBe(true);
  }
});

test("auditEntryDetail ships per-field before/after diffs", () => {
  const db = makeNode("nodeA");
  const { title, rec } = seed(db);
  updateRecord(db, rec.id, { title: "Buy oat milk" });
  const txn = lastTxn(db);
  const detail = auditEntryDetail(db, txn);
  expect(detail.entities.length).toBe(1);
  expect(detail.entities[0]!.diffs).toEqual([
    { col: title.id, label: "title", before: "Buy milk", after: "Buy oat milk" },
  ]);
  expect(() => auditEntryDetail(db, "nope")).toThrow();
});

test("document edits fold doc_blocks into the document entity", () => {
  const db = makeNode("nodeA");
  const doc = createDocument(db, { title: "Notes", body: "hello" });
  updateDocument(db, doc.id, { body: "hello\n\nworld" });
  const page = listAuditEntries(db);
  const e = page.entries[0]!;
  expect(e.entities.length).toBe(1);
  expect(e.entities[0]!.dataset).toBe("documents");
  expect(e.entities[0]!.id).toBe(doc.id);
  expect(e.entities[0]!.label).toBe("Notes");
  expect(e.entities[0]!.blocks_changed).toBeGreaterThan(0);
});

// ---- revertChangeGroup -------------------------------------------------------

test("revert restores changed cells to their pre-group values", () => {
  const db = makeNode("nodeA");
  const { rec } = seed(db);
  updateRecord(db, rec.id, { title: "WRONG" });
  const txn = lastTxn(db);
  const r = revertChangeGroup(db, txn);
  expect(r.changed).toBe(true);
  expect(r.restored_registers).toBe(1);
  expect(getRecord(db, rec.id)!.values.title).toBe("Buy milk");
  // the revert is itself a tagged revision on top of history
  expect(parseTxn(lastTxn(db)).kind).toBe("revert");
});

test("reverting a creation tombstones the row; reverting a deletion resurrects it", () => {
  const db = makeNode("nodeA");
  const { d, rec } = seed(db);
  // creation revert
  const oops = createRecord(db, d.id, { title: "Oops" });
  const createTxn = lastTxn(db);
  const r1 = revertChangeGroup(db, createTxn);
  expect(r1.removed_rows).toBe(1);
  expect(getRecord(db, oops.id)).toBeNull();
  // deletion revert
  deleteRecord(db, rec.id);
  const delTxn = lastTxn(db);
  const r2 = revertChangeGroup(db, delTxn);
  expect(r2.restored_registers).toBe(1);
  expect(getRecord(db, rec.id)!.values.title).toBe("Buy milk");
});

test("registers overwritten after the group are kept (skipped)", () => {
  const db = makeNode("nodeA");
  const { rec } = seed(db);
  updateRecord(db, rec.id, { title: "WRONG" });
  const txn = lastTxn(db);
  updateRecord(db, rec.id, { title: "Fixed by user" }); // later foreign intent
  const r = revertChangeGroup(db, txn);
  expect(r.changed).toBe(false);
  expect(r.skipped_registers).toBe(1);
  expect(getRecord(db, rec.id)!.values.title).toBe("Fixed by user");
});

test("a created row edited by someone else afterwards is kept whole", () => {
  const db = makeNode("nodeA");
  const { d } = seed(db);
  setActorTag("ai");
  const oops = createRecord(db, d.id, { title: "Oops" });
  const createTxn = lastTxn(db);
  setActorTag(null);
  updateRecord(db, oops.id, { title: "Actually keep this" });
  const r = revertChangeGroup(db, createTxn);
  expect(r.removed_rows).toBe(0);
  expect(r.skipped_rows).toBe(1);
  expect(getRecord(db, oops.id)!.values.title).toBe("Actually keep this");
});

test("a revert can itself be reverted", () => {
  const db = makeNode("nodeA");
  const { rec } = seed(db);
  updateRecord(db, rec.id, { title: "v2" });
  const editTxn = lastTxn(db);
  revertChangeGroup(db, editTxn);
  expect(getRecord(db, rec.id)!.values.title).toBe("Buy milk");
  const revertTxn = lastTxn(db);
  revertChangeGroup(db, revertTxn);
  expect(getRecord(db, rec.id)!.values.title).toBe("v2");
});

test("reverting a document edit restores the body via doc_blocks", () => {
  const db = makeNode("nodeA");
  const doc = createDocument(db, { title: "Notes", body: "hello" });
  updateDocument(db, doc.id, { body: "broken by agent" });
  const txn = lastTxn(db);
  const r = revertChangeGroup(db, txn);
  expect(r.changed).toBe(true);
  expect(getDocument(db, doc.id)!.body).toBe("hello");
});

// ---- no-op hygiene (updateRecordPrepared) ------------------------------------

test("same-value record updates emit nothing", () => {
  const db = makeNode("nodeA");
  const { rec } = seed(db);
  const before = oplogCount(db);
  updateRecord(db, rec.id, { title: "Buy milk" }); // identical value
  expect(oplogCount(db)).toBe(before);
  // and the audit feed grows no entry for it
  const page = listAuditEntries(db);
  expect(page.entries[0]!.entities[0]!.created).toBe(true); // still the creation on top
});
