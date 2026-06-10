import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import { ingest, changesSince } from "./crdt.ts";
import { parseHlc, formatHlc } from "./hlc.ts";
import { createDocument, getDocument, updateDocument, deleteDocument, documentVersion } from "./documents.ts";
import { createDatabase } from "./databases.ts";
import { addProperty, removeProperty } from "./properties.ts";
import { createRecord, getRecord, updateRecord, deleteRecord } from "./records.ts";
import { validateHub } from "./integrity.ts";
import {
  listDocumentRevisions,
  documentAtVersion,
  revertDocument,
  listRecordRevisions,
  recordAtVersion,
  revertRecord,
  recordFieldHistory,
} from "./history.ts";

function makeNode(id: string): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return db;
}

/** Jump the persisted HLC forward so the next burst of emits lands in a new
 *  revision cluster (tests run far faster than REVISION_GAP_MS). */
function advanceClock(db: Database, ms: number): void {
  const row = db.query("SELECT value FROM meta WHERE key = 'hlc'").get() as { value: string };
  const h = parseHlc(row.value);
  db.query("UPDATE meta SET value = ? WHERE key = 'hlc'").run(
    formatHlc({ ...h, millis: h.millis + ms, counter: 0 }),
  );
}

/** Full bidirectional sync between two nodes. */
function syncBoth(a: Database, b: Database): void {
  ingest(b, changesSince(a, ""));
  ingest(a, changesSince(b, ""));
}

// ---- documents -----------------------------------------------------------------

test("document history clusters saves into revisions, newest first", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "Spec", body: "alpha\n\nbeta" });
  advanceClock(db, 10_000);
  updateDocument(db, doc.id, { title: "Spec v2", body: "alpha\n\nbeta2\n\ngamma" });
  advanceClock(db, 10_000);
  updateDocument(db, doc.id, { body: "alpha" });

  const revs = listDocumentRevisions(db, doc.id);
  expect(revs.length).toBe(3);
  expect(revs[2]!.created).toBe(true);
  expect(revs[1]!.title_changed).toBe(true);
  expect(revs[0]!.blocks_deleted).toBeGreaterThan(0);
  // The newest revision's version token is the document's current version.
  expect(revs[0]!.version).toBe(documentVersion(db, doc.id));
});

test("documentAtVersion reconstructs each past state exactly", () => {
  const db = makeNode("aaaa");
  // Extra blank lines exercise blank_after round-tripping through history.
  const doc = createDocument(db, { title: "Spec", body: "alpha\n\n\n\nbeta" });
  advanceClock(db, 10_000);
  updateDocument(db, doc.id, { title: "Spec v2", body: "alpha\n\nbeta2\n\ngamma" });
  advanceClock(db, 10_000);
  updateDocument(db, doc.id, { body: "alpha" });

  const revs = listDocumentRevisions(db, doc.id);
  const v0 = documentAtVersion(db, doc.id, revs[2]!.version);
  expect(v0.title).toBe("Spec");
  expect(v0.body).toBe("alpha\n\n\n\nbeta");
  const v1 = documentAtVersion(db, doc.id, revs[1]!.version);
  expect(v1.title).toBe("Spec v2");
  expect(v1.body).toBe("alpha\n\nbeta2\n\ngamma");
  const v2 = documentAtVersion(db, doc.id, revs[0]!.version);
  expect(v2.body).toBe("alpha");
  expect(v2.body).toBe(getDocument(db, doc.id)!.body!);
});

test("documentAtVersion before creation throws not_found", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "Spec", body: "x" });
  expect(() => documentAtVersion(db, doc.id, "000000000000000-0000-zzzz")).toThrow(/no version/);
});

test("revertDocument restores a past version as a new forward revision", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "Spec", body: "alpha\n\nbeta" });
  advanceClock(db, 10_000);
  updateDocument(db, doc.id, { title: "Renamed", body: "other\n\nbody" });
  advanceClock(db, 10_000);

  const revs = listDocumentRevisions(db, doc.id);
  const r = revertDocument(db, doc.id, revs[1]!.version);
  expect(r.changed).toBe(true);
  const now = getDocument(db, doc.id)!;
  expect(now.title).toBe("Spec");
  expect(now.body).toBe("alpha\n\nbeta");
  // Revert is itself a revision; nothing was rewritten in place.
  expect(listDocumentRevisions(db, doc.id).length).toBe(3);
  // Reverting again to the same state is a no-op.
  advanceClock(db, 10_000);
  expect(revertDocument(db, doc.id, revs[1]!.version).changed).toBe(false);
  expect(validateHub(db).issues.filter((i) => i.fixable)).toEqual([]);
});

test("revertDocument honors ifMatch (stale) and missing docs (not_found)", () => {
  const db = makeNode("aaaa");
  const doc = createDocument(db, { title: "Spec", body: "a" });
  const revs = listDocumentRevisions(db, doc.id);
  expect(() => revertDocument(db, doc.id, revs[0]!.version, { ifMatch: "bogus" })).toThrow(/stale/);
  deleteDocument(db, doc.id);
  expect(() => revertDocument(db, doc.id, revs[0]!.version)).toThrow(/no such document/);
});

test("history of a synced document is identical on both nodes; revert converges", () => {
  const a = makeNode("aaaa");
  const b = makeNode("bbbb");
  const doc = createDocument(a, { title: "Spec", body: "alpha\n\nbeta" });
  syncBoth(a, b);

  advanceClock(b, 10_000);
  updateDocument(b, doc.id, { body: "alpha\n\nbeta\n\nfrom-b" });
  syncBoth(a, b);

  expect(listDocumentRevisions(a, doc.id)).toEqual(listDocumentRevisions(b, doc.id));

  advanceClock(a, 20_000);
  const revs = listDocumentRevisions(a, doc.id);
  revertDocument(a, doc.id, revs[1]!.version); // back to pre-b state
  syncBoth(a, b);

  expect(getDocument(a, doc.id)!.body).toBe("alpha\n\nbeta");
  expect(getDocument(b, doc.id)!.body).toBe(getDocument(a, doc.id)!.body!);
  expect(listDocumentRevisions(a, doc.id)).toEqual(listDocumentRevisions(b, doc.id));
});

// ---- records -------------------------------------------------------------------

function makeTable(db: Database) {
  const base = createDatabase(db, { name: "Tasks" });
  const title = addProperty(db, base.id, { name: "Title", type: "text" });
  const points = addProperty(db, base.id, { name: "Points", type: "number" });
  return { base, title, points };
}

test("record history lists revisions with the touched fields", () => {
  const db = makeNode("aaaa");
  const { base, title, points } = makeTable(db);
  const rec = createRecord(db, base.id, { Title: "T", Points: 1 });
  advanceClock(db, 10_000);
  updateRecord(db, rec.id, { Points: 2 });
  advanceClock(db, 10_000);
  updateRecord(db, rec.id, { Title: "T2", Points: 3 });

  const revs = listRecordRevisions(db, rec.id);
  expect(revs.length).toBe(3);
  expect(revs[2]!.created).toBe(true);
  expect(revs[1]!.fields).toEqual([points.id]);
  expect(new Set(revs[0]!.fields)).toEqual(new Set([title.id, points.id]));
});

test("recordAtVersion reconstructs past cells; field trail is complete", () => {
  const db = makeNode("aaaa");
  const { base, title, points } = makeTable(db);
  const rec = createRecord(db, base.id, { Title: "T", Points: 1 });
  advanceClock(db, 10_000);
  updateRecord(db, rec.id, { Points: 2 });
  advanceClock(db, 10_000);
  updateRecord(db, rec.id, { Points: 3 });

  const revs = listRecordRevisions(db, rec.id);
  const mid = recordAtVersion(db, rec.id, revs[1]!.version);
  expect(mid.data[title.id]).toBe("T");
  expect(mid.data[points.id]).toBe(2);

  const trail = recordFieldHistory(db, rec.id, points.id);
  expect(trail.map((t) => t.value)).toEqual([3, 2, 1]);
});

test("revertRecord restores cells and resurrects a deleted record", () => {
  const db = makeNode("aaaa");
  const { base, points } = makeTable(db);
  const rec = createRecord(db, base.id, { Title: "T", Points: 1 });
  advanceClock(db, 10_000);
  updateRecord(db, rec.id, { Title: "T2", Points: 2 });
  advanceClock(db, 10_000);
  deleteRecord(db, rec.id);
  advanceClock(db, 10_000);

  const revs = listRecordRevisions(db, rec.id);
  expect(revs[0]!.deleted).toBe(true);

  // Reverting *to* the deleted state is refused; revert to before it instead.
  expect(() => revertRecord(db, rec.id, revs[0]!.version)).toThrow(/deleted state/);
  const r = revertRecord(db, rec.id, revs[2]!.version);
  expect(r.undeleted).toBe(true);
  const now = getRecord(db, rec.id)!;
  expect(now.values["Title"]).toBe("T");
  expect(now.values["Points"]).toBe(1);

  // No-op revert reports changed: false.
  advanceClock(db, 10_000);
  expect(revertRecord(db, rec.id, revs[2]!.version).changed).toBe(false);
  expect(points.id in (recordAtVersion(db, rec.id, revs[2]!.version).data)).toBe(true);
  expect(validateHub(db).issues.filter((i) => i.fixable)).toEqual([]);
});

test("revertRecord skips cells of removed properties (no orphan cells)", () => {
  const db = makeNode("aaaa");
  const { base, points } = makeTable(db);
  const rec = createRecord(db, base.id, { Title: "T", Points: 7 });
  advanceClock(db, 10_000);
  updateRecord(db, rec.id, { Title: "T2" });
  advanceClock(db, 10_000);
  removeProperty(db, points.id);
  advanceClock(db, 10_000);

  const revs = listRecordRevisions(db, rec.id);
  const r = revertRecord(db, rec.id, revs.at(-1)!.version);
  expect(r.fields).not.toContain(points.id); // dead property untouched
  expect(getRecord(db, rec.id)!.values["Title"]).toBe("T");
  expect(validateHub(db).issues.filter((i) => i.fixable)).toEqual([]);
});

test("record revert converges across two synced nodes", () => {
  const a = makeNode("aaaa");
  const b = makeNode("bbbb");
  const { base } = makeTable(a);
  const rec = createRecord(a, base.id, { Title: "T", Points: 1 });
  syncBoth(a, b);

  advanceClock(b, 10_000);
  updateRecord(b, rec.id, { Points: 99 });
  syncBoth(a, b);

  advanceClock(a, 20_000);
  const revs = listRecordRevisions(a, rec.id);
  revertRecord(a, rec.id, revs.at(-1)!.version);
  syncBoth(a, b);

  expect(getRecord(a, rec.id)!.values["Points"]).toBe(1);
  expect(getRecord(b, rec.id)).toEqual(getRecord(a, rec.id));
  expect(listRecordRevisions(b, rec.id)).toEqual(listRecordRevisions(a, rec.id));
});
