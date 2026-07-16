import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import { emit, ingest, changesSince } from "./crdt.ts";
import {
  createDocument,
  getDocument,
  updateDocument,
  moveDocument,
  editDocument,
  editDocumentBatch,
  appendDocument,
  prependDocument,
  duplicateDocument,
  documentVersion,
  listDocuments,
  backfillDocumentOrderKeys,
} from "./documents.ts";
import { listDocumentRevisions } from "./history.ts";

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

test("duplicateDocument copies title + blocks into a new doc placed after the source", () => {
  const db = makeNode("aaaa");
  const a = createDocument(db, { title: "A", body: "" });
  const src = createDocument(db, { title: "Spec", body: "alpha\n\nbeta" });
  const z = createDocument(db, { title: "Z", body: "" });

  const dup = duplicateDocument(db, src.id);
  expect(dup.id).not.toBe(src.id);
  expect(dup.title).toBe("Spec");
  expect(dup.body).toBe("alpha\n\nbeta");
  // Fresh block ids, not shared with the source.
  expect(blockIds(db, dup.id).length).toBe(2);
  expect(blockIds(db, dup.id).some((id) => blockIds(db, src.id).includes(id))).toBe(false);
  // Editing the copy must not touch the source.
  updateDocument(db, dup.id, { body: "changed" });
  expect(getDocument(db, src.id)!.body).toBe("alpha\n\nbeta");

  // Sits immediately after its source among siblings.
  const order = listDocuments(db).map((d) => d.id);
  expect(order).toEqual([a.id, src.id, dup.id, z.id]);

  // Optional title override.
  const named = duplicateDocument(db, src.id, { title: "Spec 副本" });
  expect(named.title).toBe("Spec 副本");
});

test("duplicateDocument preserves database_id and parent_id", () => {
  const db = makeNode("aaaa");
  const parent = createDocument(db, { title: "Parent" });
  const src = createDocument(db, { title: "Child", body: "x", parent_id: parent.id, database_id: "db_scope" });
  const dup = duplicateDocument(db, src.id);
  expect(dup.parent_id).toBe(parent.id);
  expect(dup.database_id).toBe("db_scope");
});

test("duplicateDocument throws for a missing document", () => {
  const db = makeNode("aaaa");
  expect(() => duplicateDocument(db, "doc_missing")).toThrow(/no such document/);
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

test("editDocumentBatch applies several pairs as one atomic, single-versioned pass", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "T", body: "alpha\n\ndone done\n\nomega" });
  const revsBefore = listDocumentRevisions(db, doc.id).length;

  const r = editDocumentBatch(db, doc.id, {
    edits: [
      { old: "alpha", new: "ALPHA" },
      { old: "omega", new: "OMEGA" },
      { old: "done", new: "x", replaceAll: true },
    ],
  });
  expect(r.changed).toBe(true);
  expect(r.replaced).toBe(4); // 1 + 1 + 2
  expect(getDocument(db, doc.id)!.body).toBe("ALPHA\n\nx x\n\nOMEGA");
  // One grouped txn → exactly one new revision, one version bump.
  expect(listDocumentRevisions(db, doc.id).length).toBe(revsBefore + 1);
});

test("editDocumentBatch folds pairs left-to-right (a later old can match an earlier new)", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "T", body: "one" });
  editDocumentBatch(db, doc.id, {
    edits: [
      { old: "one", new: "two" },
      { old: "two", new: "three" },
    ],
  });
  expect(getDocument(db, doc.id)!.body).toBe("three");
});

test("editDocumentBatch is atomic: a failing pair leaves the document untouched", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "T", body: "foo\n\nfoo\n\nbar" });
  const before = getDocument(db, doc.id)!.body;
  const v = documentVersion(db, doc.id);

  // Second pair's anchor is missing → whole batch aborts, first pair not applied.
  expect(() =>
    editDocumentBatch(db, doc.id, {
      edits: [
        { old: "bar", new: "BAR" },
        { old: "zzz", new: "x" },
      ],
    }),
  ).toThrow(/edit\[1\]: anchor not found/);
  // Ambiguous pair (multiple matches, no replaceAll) also aborts the batch.
  expect(() =>
    editDocumentBatch(db, doc.id, { edits: [{ old: "foo", new: "x" }] }),
  ).toThrow(/edit\[0\]: 2 matches/);

  expect(getDocument(db, doc.id)!.body).toBe(before);
  expect(documentVersion(db, doc.id)).toBe(v); // no emit ⇒ version unchanged
});

test("editDocumentBatch honors --if-match", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "T", body: "hello" });
  const v = documentVersion(db, doc.id);
  editDocument(db, doc.id, { old: "hello", new: "hi" }); // bumps version
  expect(() =>
    editDocumentBatch(db, doc.id, { edits: [{ old: "hi", new: "yo" }], ifMatch: v }),
  ).toThrow(/stale/);
});

test("editDocumentBatch leaves code fences and tables byte-identical when editing around them", () => {
  const db = makeNode("aaaa");
  const fence = "```js\nconst done = 1;\n```";
  const tableMd = "| a | b |\n| - | - |\n| 1 | 2 |";
  const body = ["intro", fence, tableMd, "outro"].join("\n\n");
  const doc = createDocument(db, { title: "T", body });
  expect(getDocument(db, doc.id)!.body).toBe(body); // create round-trips them

  editDocumentBatch(db, doc.id, {
    edits: [
      { old: "intro", new: "INTRO" },
      { old: "outro", new: "OUTRO" },
    ],
  });
  // The typed/void-ish blocks are untouched; the doc round-trips losslessly.
  expect(getDocument(db, doc.id)!.body).toBe(
    ["INTRO", fence, tableMd, "OUTRO"].join("\n\n"),
  );
});

test("edit writes the replacement verbatim — no $-pattern expansion", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "T", body: "price is X here" });
  // `$&`/`$$`/`` $` `` would be expanded by a string replacement; the function
  // replacer must write them literally.
  editDocument(db, doc.id, { old: "X", new: "$& $$5 $`" });
  expect(getDocument(db, doc.id)!.body).toBe("price is $& $$5 $` here");
});

test("editDocumentBatch writes replacements verbatim — no $-pattern expansion", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "T", body: "a b" });
  editDocumentBatch(db, doc.id, {
    edits: [
      { old: "a", new: "$&" },
      { old: "b", new: "$$1" },
    ],
  });
  expect(getDocument(db, doc.id)!.body).toBe("$& $$1");
});

test("editDocumentBatch that nets no change reports changed:false", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "T", body: "cat" });
  const v = documentVersion(db, doc.id);
  const r = editDocumentBatch(db, doc.id, {
    edits: [
      { old: "cat", new: "dog" },
      { old: "dog", new: "cat" },
    ],
  });
  expect(r.changed).toBe(false); // body identical to the original
  expect(r.replaced).toBe(2); // pairs still applied and folded
  expect(getDocument(db, doc.id)!.body).toBe("cat");
  expect(documentVersion(db, doc.id)).toBe(v); // no write, no version bump
});

test("single edit with old === new reports changed:false and does not bump version", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "T", body: "hello world" });
  const v = documentVersion(db, doc.id);
  const r = editDocument(db, doc.id, { old: "world", new: "world" });
  expect(r.changed).toBe(false);
  expect(documentVersion(db, doc.id)).toBe(v);
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

test("new documents append to the end of their sibling group", () => {
  const db = makeNode("aaaa");
  const a = createDocument(db, { title: "A" });
  const b = createDocument(db, { title: "B" });
  const c = createDocument(db, { title: "C" });
  expect(listDocuments(db).map((d) => d.title)).toEqual(["A", "B", "C"]);
  expect([a, b, c].every((d) => getDocument(db, d.id)!.order_key != null)).toBe(true);
});

test("moveDocument reorders siblings (before/after)", () => {
  const db = makeNode("aaaa");
  const a = createDocument(db, { title: "A" });
  const b = createDocument(db, { title: "B" });
  const c = createDocument(db, { title: "C" });

  moveDocument(db, c.id, a.id, "before"); // C jumps to the front
  expect(listDocuments(db).map((d) => d.title)).toEqual(["C", "A", "B"]);

  moveDocument(db, a.id, b.id, "after"); // A drops to the end
  expect(listDocuments(db).map((d) => d.title)).toEqual(["C", "B", "A"]);
});

test("moveDocument into nests as the last child", () => {
  const db = makeNode("aaaa");
  const parent = createDocument(db, { title: "P" });
  createDocument(db, { title: "X", parent_id: parent.id });
  const y = createDocument(db, { title: "Y" }); // top level

  moveDocument(db, y.id, parent.id, "into");
  expect(getDocument(db, y.id)!.parent_id).toBe(parent.id);
  expect(listDocuments(db, { parent_id: parent.id }).map((d) => d.title)).toEqual(["X", "Y"]);
});

test("moveDocument rejects nesting into a descendant", () => {
  const db = makeNode("aaaa");
  const a = createDocument(db, { title: "A" });
  const b = createDocument(db, { title: "B", parent_id: a.id });
  expect(() => moveDocument(db, a.id, b.id, "into")).toThrow(/cycle/);
});

test("backfill assigns order_key to legacy docs, preserving created_hlc order", () => {
  const db = makeNode("aaaa");
  // Legacy top-level documents emitted without an order_key.
  for (const [id, hlc] of [["d-a", "1"], ["d-b", "2"], ["d-c", "3"]] as const) {
    emit(db, "documents", id, "title", id);
    emit(db, "documents", id, "created_hlc", hlc);
  }
  expect(listDocuments(db).every((d) => d.order_key == null)).toBe(true);
  expect(listDocuments(db).map((d) => d.id)).toEqual(["d-a", "d-b", "d-c"]);

  backfillDocumentOrderKeys(db);
  const after = listDocuments(db);
  expect(after.map((d) => d.id)).toEqual(["d-a", "d-b", "d-c"]);
  expect(after.every((d) => d.order_key != null)).toBe(true);
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
