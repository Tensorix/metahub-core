import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import { emit, ingest, changesSince } from "./crdt.ts";
import {
  createDocument,
  getDocument,
  updateDocument,
  editDocument,
  appendDocument,
  prependDocument,
  documentVersion,
  listDocuments,
} from "./documents.ts";

function makeNode(id: string): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return db;
}

function blockIds(db: Database, docId: string): string[] {
  return (
    db
      .query(
        "SELECT id FROM doc_blocks WHERE doc_id = ? AND __deleted = 0 ORDER BY order_key, id",
      )
      .all(docId) as { id: string }[]
  ).map((r) => r.id);
}

test("create stores body as blocks; getDocument returns serialized body", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "Spec", body: "alpha\n\nbeta\n\ngamma" });
  expect(getDocument(db, doc.id)!.body).toBe("alpha\n\nbeta\n\ngamma");
  expect(blockIds(db, doc.id).length).toBe(3);
});

test("create with no body leaves body null and no blocks", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "Empty" });
  expect(getDocument(db, doc.id)!.body).toBeNull();
  expect(blockIds(db, doc.id).length).toBe(0);
});

test("listDocuments filters by parent_id", () => {
  const db = makeNode("aaaa");
  const parent = createDocument(db, { title: "Quick Notes" });
  const a = createDocument(db, { title: "Note A", parent_id: parent.id });
  const b = createDocument(db, { title: "Note B", parent_id: parent.id });
  createDocument(db, { title: "Unrelated" }); // top-level, excluded

  const kids = listDocuments(db, { parent_id: parent.id });
  expect(kids.map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
  expect(kids.every((d) => d.parent_id === parent.id)).toBe(true);
});

test("single-block edit preserves block identity", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "T", body: "one\n\ntwo\n\nthree" });
  const before = blockIds(db, doc.id);

  const r = editDocument(db, doc.id, { old: "two", new: "TWO" });
  expect(r.changed).toBe(true);
  expect(getDocument(db, doc.id)!.body).toBe("one\n\nTWO\n\nthree");
  expect(blockIds(db, doc.id)).toEqual(before); // same ids, in place
});

test("edit errors on missing anchor and ambiguous match", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "T", body: "foo\n\nfoo\n\nbar" });
  expect(() => editDocument(db, doc.id, { old: "zzz", new: "x" })).toThrow(/anchor not found/);
  expect(() => editDocument(db, doc.id, { old: "foo", new: "x" })).toThrow(/2 matches/);

  const r = editDocument(db, doc.id, { old: "foo", new: "X", replaceAll: true });
  expect(r.replaced).toBe(2);
  expect(getDocument(db, doc.id)!.body).toBe("X\n\nX\n\nbar");
});

test("--if-match rejects a stale edit", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "T", body: "hello" });
  const v = documentVersion(db, doc.id);
  editDocument(db, doc.id, { old: "hello", new: "hi" }); // bumps version
  expect(() => editDocument(db, doc.id, { old: "hi", new: "yo", ifMatch: v })).toThrow(/stale/);
});

test("edit that introduces a block break splits into blocks", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "T", body: "intro here" });
  editDocument(db, doc.id, { old: "intro here", new: "intro\n\nbody" });
  expect(getDocument(db, doc.id)!.body).toBe("intro\n\nbody");
  expect(blockIds(db, doc.id).length).toBe(2);
});

test("append and prepend add blocks at the ends", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "T", body: "mid" });
  appendDocument(db, doc.id, "tail");
  prependDocument(db, doc.id, "head");
  expect(getDocument(db, doc.id)!.body).toBe("head\n\nmid\n\ntail");
});

test("legacy body-only document is migrated to blocks on first edit", () => {
  const db = makeNode("aaaa");
  const id = "legacy-doc";
  emit(db, "documents", id, "title", "Legacy");
  emit(db, "documents", id, "created_hlc", "0");
  emit(db, "documents", id, "body", "old line\n\nsecond");
  expect(blockIds(db, id).length).toBe(0);

  editDocument(db, id, { old: "old line", new: "new line" });
  expect(getDocument(db, id)!.body).toBe("new line\n\nsecond");
  expect(blockIds(db, id).length).toBe(2);
});

test("update --body reconciles, keeping unchanged block identity", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "T", body: "keep1\n\nchangeme\n\nkeep2" });
  const ids = blockIds(db, doc.id);

  updateDocument(db, doc.id, { body: "keep1\n\nchanged\n\nkeep2" });
  const after = blockIds(db, doc.id);
  expect(getDocument(db, doc.id)!.body).toBe("keep1\n\nchanged\n\nkeep2");
  expect(after[0]).toBe(ids[0]!); // keep1 identity preserved
  expect(after[2]).toBe(ids[2]!); // keep2 identity preserved
});

test("interior and trailing blank lines persist through create and reload", () => {
  const db = makeNode("aaaa");
  const body = "alpha\n\n\nbeta\n\n"; // extra blank line between, blank line at end
  const doc = createDocument(db, { title: "T", body });
  expect(getDocument(db, doc.id)!.body).toBe(body);
  // the spacing rides on the blocks, not zero-content rows
  expect(blockIds(db, doc.id).length).toBe(2);
});

test("changing only blank spacing keeps block identity (no churn)", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "T", body: "a\n\nb" });
  const ids = blockIds(db, doc.id);

  // add two blank lines after "a" — text is unchanged, so identities must hold
  updateDocument(db, doc.id, { body: "a\n\n\n\nb" });
  expect(getDocument(db, doc.id)!.body).toBe("a\n\n\n\nb");
  expect(blockIds(db, doc.id)).toEqual(ids);

  // removing the spacing again round-trips back to canonical
  updateDocument(db, doc.id, { body: "a\n\nb" });
  expect(getDocument(db, doc.id)!.body).toBe("a\n\nb");
  expect(blockIds(db, doc.id)).toEqual(ids);
});

test("update reparents a document and --top clears the parent", () => {
  const db = makeNode("aaaa");
  const parent = createDocument(db, { title: "Parent" });
  const child = createDocument(db, { title: "Child" });

  updateDocument(db, child.id, { parent_id: parent.id });
  expect(getDocument(db, child.id)!.parent_id).toBe(parent.id);

  updateDocument(db, child.id, { parent_id: null });
  expect(getDocument(db, child.id)!.parent_id).toBeNull();
});

test("update rejects parent cycles (self and descendant)", () => {
  const db = makeNode("aaaa");
  const a = createDocument(db, { title: "A" });
  const b = createDocument(db, { title: "B" });
  updateDocument(db, b.id, { parent_id: a.id }); // B under A

  // A cannot become its own parent, nor a child of its descendant B.
  expect(() => updateDocument(db, a.id, { parent_id: a.id })).toThrow(/cycle/);
  expect(() => updateDocument(db, a.id, { parent_id: b.id })).toThrow(/cycle/);
  // Unaffected edge stays intact.
  expect(getDocument(db, b.id)!.parent_id).toBe(a.id);
});

test("PAYOFF: concurrent edits to different blocks of one doc both survive", () => {
  const a = makeNode("aaaa");
  const doc = createDocument(a, { title: "Spec", body: "para one\n\npara two\n\npara three" });

  // Replicate the whole doc to B.
  const b = makeNode("bbbb");
  ingest(b, changesSince(a, ""));
  expect(getDocument(b, doc.id)!.body).toBe("para one\n\npara two\n\npara three");

  // Concurrent edits: A touches the first block, B touches the last block.
  editDocument(a, doc.id, { old: "para one", new: "PARA ONE" });
  editDocument(b, doc.id, { old: "para three", new: "PARA THREE" });

  // Exchange in both directions (idempotent).
  ingest(a, changesSince(b, ""));
  ingest(b, changesSince(a, ""));

  const merged = "PARA ONE\n\npara two\n\nPARA THREE";
  expect(getDocument(a, doc.id)!.body).toBe(merged); // both edits present
  expect(getDocument(b, doc.id)!.body).toBe(getDocument(a, doc.id)!.body);
});
