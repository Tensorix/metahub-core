import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSchema } from "./db.ts";
import { ingest, changesSince, changesAfterSeq, emit } from "./crdt.ts";
import { parseHlc, formatHlc } from "./hlc.ts";
import { createDocument, getDocument, updateDocument } from "./documents.ts";
import { createDatabase } from "./databases.ts";
import { addProperty } from "./properties.ts";
import { createRecord, getRecord, updateRecord, deleteRecord } from "./records.ts";
import { listDocumentRevisions, documentAtVersion } from "./history.ts";
import { validateHub } from "./integrity.ts";
import { compactOplog, gcBlobs, compactEstimate } from "./compact.ts";
import { createSite, putFile, getFileForServe } from "./sites.ts";
import {
  INTENT_RECEIPT_DATASET,
  INTENT_REPLAY_WINDOW_MS,
} from "./intent-retention.ts";

function makeNode(id: string): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return db;
}

function advanceClock(db: Database, ms: number): void {
  const row = db.query("SELECT value FROM meta WHERE key = 'hlc'").get() as { value: string };
  const h = parseHlc(row.value);
  db.query("UPDATE meta SET value = ? WHERE key = 'hlc'").run(
    formatHlc({ ...h, millis: h.millis + ms, counter: 0 }),
  );
}

function syncBoth(a: Database, b: Database): void {
  ingest(b, changesSince(a, ""));
  ingest(a, changesSince(b, ""));
}

/** Materialized snapshot of the user-facing tables, for byte-identical compares. */
function headState(db: Database) {
  const dump = (sql: string) => db.query(sql).all();
  return {
    documents: dump("SELECT * FROM documents ORDER BY id"),
    doc_blocks: dump("SELECT * FROM doc_blocks ORDER BY id"),
    records: dump("SELECT * FROM records ORDER BY id"),
    properties: dump("SELECT * FROM properties ORDER BY id"),
    databases: dump("SELECT * FROM databases ORDER BY id"),
  };
}

/** A db with a few revisions: doc edited twice, record updated, one deleted record. */
function seed(db: Database) {
  const doc = createDocument(db, { title: "Spec", body: "alpha\n\nbeta" });
  const base = createDatabase(db, { name: "Tasks" });
  addProperty(db, base.id, { name: "Title", type: "text" });
  addProperty(db, base.id, { name: "Points", type: "number" });
  const rec = createRecord(db, base.id, { Title: "T", Points: 1 });
  const dead = createRecord(db, base.id, { Title: "Gone" });
  advanceClock(db, 10_000);
  updateDocument(db, doc.id, { body: "alpha\n\nbeta2\n\ngamma" });
  updateRecord(db, rec.id, { Points: 2 });
  deleteRecord(db, dead.id);
  advanceClock(db, 10_000);
  updateDocument(db, doc.id, { title: "Spec v3", body: "final" });
  updateRecord(db, rec.id, { Points: 3 });
  return { doc, base, rec, dead };
}

/** now() far enough in the future that keepDays=0 compacts everything so far. */
function futureNow(db: Database): number {
  const row = db.query("SELECT MAX(hlc) AS h FROM crdt_changes").get() as { h: string };
  return parseHlc(row.h).millis + 1;
}

test("compaction leaves the materialized head state byte-identical", () => {
  const db = makeNode("aaaa");
  seed(db);
  const before = headState(db);
  const total = (db.query("SELECT COUNT(*) AS n FROM crdt_changes").get() as { n: number }).n;

  const r = compactOplog(db, { keepDays: 0, now: futureNow(db), vacuum: false });
  expect(r.deleted_changes).toBeGreaterThan(0);
  expect(r.kept_changes).toBe(total - r.deleted_changes);
  expect(headState(db)).toEqual(before);

  // A fresh node fed only the compacted oplog converges to the same state.
  const fresh = makeNode("bbbb");
  ingest(fresh, changesSince(db, ""));
  expect(headState(fresh)).toEqual(before);
  expect(validateHub(db).issues.filter((i) => i.fixable)).toEqual([]);
});

test("history inside the window survives; overwritten registers collapse outside it", () => {
  const db = makeNode("aaaa");
  // Title is ONE register overwritten repeatedly — exactly what compaction prunes.
  const doc = createDocument(db, { title: "T1", body: "body" });
  advanceClock(db, 10_000);
  updateDocument(db, doc.id, { title: "T2" });
  advanceClock(db, 10_000);
  updateDocument(db, doc.id, { title: "T3" });

  const revsBefore = listDocumentRevisions(db, doc.id);
  expect(revsBefore.length).toBe(3);
  const cutoffRev = revsBefore[1]!; // the T2 revision

  // Window edge right after T2: the T1 value collapses, T2 (winner at the
  // edge) and everything after stay.
  const keepFrom = parseHlc(cutoffRev.version).millis + 1;
  const now = futureNow(db);
  compactOplog(db, { keepDays: (now - keepFrom) / 86_400_000, now, vacuum: false });

  expect(getDocument(db, doc.id)!.title).toBe("T3");
  // State at the window edge is still exact …
  expect(documentAtVersion(db, doc.id, cutoffRev.version).title).toBe("T2");
  // … but the pre-window T1 value is gone (its write was superseded inside the
  // compacted range), so reconstruction at the T1 version no longer sees it.
  expect(documentAtVersion(db, doc.id, revsBefore[2]!.version).title).not.toBe("T1");
  const revsAfter = listDocumentRevisions(db, doc.id);
  expect(revsAfter[0]!.version).toBe(revsBefore[0]!.version); // T3 revision intact
});

test("tombstones survive compaction: deleted rows stay deleted on fresh peers", () => {
  const db = makeNode("aaaa");
  const { dead } = seed(db);
  compactOplog(db, { keepDays: 0, now: futureNow(db), vacuum: false });

  expect(getRecord(db, dead.id)).toBeNull();
  const fresh = makeNode("bbbb");
  ingest(fresh, changesSince(db, ""));
  expect(getRecord(fresh, dead.id)).toBeNull();
});

test("a lagging peer converges after the source compacts", () => {
  const a = makeNode("aaaa");
  const b = makeNode("bbbb");
  const doc = createDocument(a, { title: "Spec", body: "v1" });
  syncBoth(a, b); // b has v1
  advanceClock(a, 10_000);
  updateDocument(a, doc.id, { body: "v2" });
  advanceClock(a, 10_000);
  updateDocument(a, doc.id, { body: "v3" });
  // b missed v2/v3; a compacts away the superseded v2 blocks first.
  compactOplog(a, { keepDays: 0, now: futureNow(a), vacuum: false });
  syncBoth(a, b);
  expect(getDocument(b, doc.id)!.body).toBe("v3");
  expect(headState(b).doc_blocks).toEqual(headState(a).doc_blocks);
});

test("rowid monotonicity: cursors taken before compaction never skip new changes", () => {
  const db = makeNode("aaaa");
  seed(db);
  const cursor = changesAfterSeq(db, 0).cursor; // peer's high-water mark
  compactOplog(db, { keepDays: 0, now: futureNow(db), vacuum: false });
  emit(db, "databases", "db_probe-zzzzzz", "name", "probe");
  const batch = changesAfterSeq(db, cursor);
  expect(batch.changes.some((c) => c.row_id === "db_probe-zzzzzz")).toBe(true);
});

test("blob GC removes superseded site files and keeps the live one", async () => {
  const home = mkdtempSync(join(tmpdir(), "mh-compact-"));
  process.env.METAHUB_HOME = home;
  try {
    const db = makeNode("aaaa");
    const site = createSite(db, { name: "demo" });
    const big = (fill: string) => new Uint8Array(300_000).fill(fill.charCodeAt(0)); // > INLINE_LIMIT -> blob
    await putFile(db, site.id, "a.bin", { data: big("x"), contentType: "application/octet-stream" });
    advanceClock(db, 10_000);
    await putFile(db, site.id, "a.bin", { data: big("y"), contentType: "application/octet-stream" });
    const cacheFiles = () => (existsSync(join(home, "cache")) ? readdirSync(join(home, "cache")) : []);
    expect(cacheFiles().length).toBe(2);

    // Before compaction the old blob is still referenced by oplog history.
    expect(gcBlobs(db, { dryRun: true }).deleted).toBe(0);
    compactOplog(db, { keepDays: 0, now: futureNow(db), vacuum: false });
    expect(cacheFiles().length).toBe(1);

    const served = await getFileForServe(db, site.id, "a.bin");
    expect(served).not.toBeNull();
    expect(served!.bytes[0]).toBe("y".charCodeAt(0));
  } finally {
    delete process.env.METAHUB_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("dry run reports counts without changing anything", () => {
  const db = makeNode("aaaa");
  seed(db);
  const before = (db.query("SELECT COUNT(*) AS n FROM crdt_changes").get() as { n: number }).n;
  const r = compactOplog(db, { keepDays: 0, now: futureNow(db), dryRun: true });
  expect(r.dry_run).toBe(true);
  expect(r.deleted_changes).toBeGreaterThan(0);
  const after = (db.query("SELECT COUNT(*) AS n FROM crdt_changes").get() as { n: number }).n;
  expect(after).toBe(before);
  expect(compactEstimate(db, 0, futureNow(db)).compactable_changes).toBe(r.deleted_changes);
});

test("compaction collects expired intent receipts even though they are not superseded", () => {
  const db = makeNode("aaaa");
  const acceptedAt = 1_700_000_000_000;
  expect(
    ingest(
      db,
      [
        {
          hlc: formatHlc({ millis: acceptedAt, counter: 0, node: "guest" }),
          node_id: "guest",
          dataset: INTENT_RECEIPT_DATASET,
          row_id: "guest:int_old",
          col: "result",
          value: "{}",
          txn: "intent:guest:int_old:fingerprint",
        },
      ],
      { now: acceptedAt },
    ),
  ).toBe(1);
  const now = acceptedAt + INTENT_REPLAY_WINDOW_MS + 1;
  expect(compactEstimate(db, 3650, now).compactable_changes).toBe(1);
  const result = compactOplog(db, {
    keepDays: 3650,
    now,
    vacuum: false,
  });
  expect(result.deleted_changes).toBe(1);
  expect(
    db
      .query("SELECT COUNT(*) AS n FROM crdt_changes WHERE dataset = ?")
      .get(INTENT_RECEIPT_DATASET),
  ).toEqual({ n: 0 });
});
