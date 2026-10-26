import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema, ftsAvailable } from "./db.ts";
import { ingest, type Change } from "./crdt.ts";
import { search, rebuildSearchIndex, querySearch, querySearchIncrementally } from "./search.ts";
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

test("native search rebuild checkpoints bounded pages and catches writes made between them", async () => {
  const { updateSearchIndexStep, searchIncrementally } = await import("./search.ts");
  const db = makeNode();
  try {
    for (let i = 0; i < 205; i++) createDocument(db, { title: `Page ${i}`, body: "Search across pages" });
    expect(updateSearchIndexStep(db, 20).ready).toBe(false);
    expect(db.query("SELECT count(*) AS n FROM search_fts").get()).toEqual({ n: 20 });
    expect(db.query("SELECT value FROM meta WHERE key = 'search_rebuild'").get()).not.toBeNull();
    const added = createDocument(db, { title: "Added during build", body: "newbodytoken" });
    let yielded = false; setTimeout(() => { yielded = true; }, 0);
    const result = await searchIncrementally(db, "newbodytoken", { batchSize: 20 });
    expect(yielded).toBe(true);
    expect(result.map(row => row.id)).toContain(added.id);
    expect(db.query("SELECT value FROM meta WHERE key = 'search_rebuild'").get()).toBeNull();
    const { dbId, propId } = withTextDb(db);
    const record = createRecord(db, dbId, { Body: "propertytoken" });
    expect((await searchIncrementally(db, "propertytoken", { batchSize: 20 })).map(row => row.id)).toContain(record.id);
    updateProperty(db, propId, { type: "number" });
    expect(await searchIncrementally(db, "propertytoken", { batchSize: 20 })).toEqual([]);
  } finally { db.close(); }
});

test("cancelled native search never resumes against a closed database", async () => {
  const { searchIncrementally } = await import("./search.ts");
  const db = makeNode();
  const abort = new AbortController();
  const searching = searchIncrementally(db, "anything", { batchSize: 1, signal: abort.signal });
  abort.abort(new Error("owner closed"));
  db.close();
  await expect(searching).rejects.toThrow("owner closed");
});


test("querySearch pages beyond fifty tied hits with deterministic ids and an empty terminal page", async () => {
  const db = makeNode();
  try {
    const expected = Array.from({ length: 117 }, () => createDocument(db, { title: "Same", body: "pagedneedle" }).id).sort();
    const first = await querySearchIncrementally(db, "pagedneedle", { limit: 50, batchSize: 11 });
    const second = querySearch(db, "pagedneedle", { offset: 50, limit: 50 });
    const third = querySearch(db, "pagedneedle", { offset: 100, limit: 50 });
    expect(first).toMatchObject({ offset: 0, limit: 50, hasMore: true });
    expect(second.hasMore).toBe(true);
    expect(third.hasMore).toBe(false);
    expect([...first.hits, ...second.hits, ...third.hits].map(hit => hit.id)).toEqual(expected);
    expect(querySearch(db, "pagedneedle", { offset: 117 }).hits).toEqual([]);
    expect(querySearch(db, "pagedneedle", { offset: 50 }).hits.map(hit => hit.id)).toEqual(second.hits.map(hit => hit.id));
  } finally { db.close(); }
});

test("querySearch never changes an exhausted FTS page to substring results", () => {
  const db = makeNode();
  try {
    const exact = createDocument(db, { title: "Exact", body: "wholeword" });
    createDocument(db, { title: "Substring only", body: "wholewordsuffix" });
    expect(querySearch(db, "wholeword", { limit: 1 }).hits.map(hit => hit.id)).toEqual([exact.id]);
    expect(querySearch(db, "wholeword", { offset: 1, limit: 1 })).toMatchObject({ hits: [], hasMore: false });
  } finally { db.close(); }
});

test("CJK substring pages span documents and records, preserve wildcards, and handle no results", () => {
  const db = makeNode();
  try {
    const docs = Array.from({ length: 53 }, () => createDocument(db, { title: "日记", body: "记录项目进展以及100%_完成" }).id).sort();
    const { dbId } = withTextDb(db);
    const rec = createRecord(db, dbId, { Body: "今日项目进展" });
    const first = querySearch(db, "项目进展", { limit: 50 });
    const next = querySearch(db, "项目进展", { offset: 50, limit: 50 });
    expect(first.hasMore).toBe(true);
    expect(next.hasMore).toBe(false);
    expect([...first.hits, ...next.hits].map(hit => hit.id)).toEqual([...docs, rec.id]);
    expect(querySearch(db, "100%_").hits).toHaveLength(50);
    expect(querySearch(db, "不存在")).toMatchObject({ hits: [], hasMore: false });
    expect(querySearch(db, "   ")).toMatchObject({ hits: [], hasMore: false });
  } finally { db.close(); }
});

test("querySearch fallback pages also work when FTS is unavailable", () => {
  const db = makeNode();
  try {
    db.exec("DROP TABLE search_fts");
    for (let i = 0; i < 56; i++) createDocument(db, { title: "Fallback", body: "unindexedtoken" });
    expect(querySearch(db, "unindexedtoken", { limit: 50 }).hasMore).toBe(true);
    expect(querySearch(db, "unindexedtoken", { offset: 50, limit: 50 }).hits).toHaveLength(6);
    expect(querySearch(db, "unindexedtoken", { offset: 56 }).hits).toEqual([]);
  } finally { db.close(); }
});


test("bounded index pages use a constant number of bridge calls and preserve legacy index rows", async () => {
  const { updateSearchIndexStep } = await import("./search.ts");
  const db = makeNode();
  try {
    const { dbId } = withTextDb(db);
    for (let i = 0; i < 25; i++) createRecord(db, dbId, { Body: `Indexed ${i}` });
    let calls = 0;
    const measured = {
      exec: db.exec.bind(db), transaction: db.transaction.bind(db),
      query(sql: string) {
        const stmt = db.query(sql);
        return { get: (...args: any[]) => { calls++; return stmt.get(...args); }, run: (...args: any[]) => { calls++; return stmt.run(...args); }, all: (...args: any[]) => { calls++; return stmt.all(...args); } };
      },
    };
    updateSearchIndexStep(measured, 25); // documents phase (empty)
    calls = 0;
    expect(updateSearchIndexStep(measured, 25).ready).toBe(false);
    expect(calls).toBeLessThanOrEqual(8);
    const indexed = db.query("SELECT kind,id,database_id,title,body FROM search_fts ORDER BY kind,id").all();
    expect(indexed).toHaveLength(25);
    rebuildSearchIndex(db);
    expect(db.query("SELECT kind,id,database_id,title,body FROM search_fts ORDER BY kind,id").all()).toEqual(indexed);
  } finally { db.close(); }
});

test("a failing bulk index insert rolls back deleted rows and checkpoint together before retry", async () => {
  const { updateSearchIndexStep } = await import("./search.ts");
  const db = makeNode();
  try {
    const { dbId } = withTextDb(db);
    const record = createRecord(db, dbId, { Body: "neutral seed" });
    updateRecord(db, record.id, { Body: "expiredword indexed body" });
    search(db, "indexed");
    const before = db.query("SELECT * FROM search_fts ORDER BY kind,id").all();
    const cursor = db.query("SELECT value FROM meta WHERE key='search_seq'").get();
    updateRecord(db, record.id, { Body: "freshword indexed body" });
    let fail = true;
    const broken = {
      exec: db.exec.bind(db), transaction: db.transaction.bind(db),
      query(sql: string) {
        const stmt = db.query(sql);
        return { get: (...args: any[]) => stmt.get(...args), all: (...args: any[]) => stmt.all(...args), run: (...args: any[]) => {
          if (fail && sql.startsWith("INSERT INTO search_fts")) { fail = false; throw new Error("native index write failed"); }
          return stmt.run(...args);
        } };
      },
    };
    expect(() => updateSearchIndexStep(broken, 25)).toThrow("native index write failed");
    expect(db.query("SELECT * FROM search_fts ORDER BY kind,id").all()).toEqual(before);
    expect(db.query("SELECT value FROM meta WHERE key='search_seq'").get()).toEqual(cursor);
    expect(updateSearchIndexStep(db, 25).ready).toBe(true);
    expect(querySearch(db, "freshword", { maintainIndex: false }).hits.map(hit => hit.id)).toEqual([record.id]);
    expect(querySearch(db, "expiredword", { maintainIndex: false }).hits).toEqual([]);
  } finally { db.close(); }
});
