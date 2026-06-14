import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema, migratePeers, migrateCrdtChangesSeq } from "./schema-init.ts";

function hasCol(db: Database, table: string, col: string): boolean {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
    (c) => c.name === col,
  );
}

test("runSchema creates the storage_cursors table", () => {
  const db = new Database(":memory:");
  runSchema(db);
  const t = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='storage_cursors'")
    .get();
  expect(t).not.toBeNull();
});

test("migratePeers adds kind/config to a legacy peers table, preserving cursors", () => {
  const db = new Database(":memory:");
  // Legacy shape: only the original three columns, no pairing/storage columns.
  db.exec("CREATE TABLE peers (url TEXT PRIMARY KEY, pull_cursor INTEGER, push_cursor INTEGER)");
  db.query("INSERT INTO peers (url, pull_cursor, push_cursor) VALUES ('http://x', 5, 7)").run();

  migratePeers(db);
  expect(hasCol(db, "peers", "kind")).toBe(true);
  expect(hasCol(db, "peers", "config")).toBe(true);
  expect(hasCol(db, "peers", "token")).toBe(true); // older pairing columns too

  const row = db
    .query("SELECT pull_cursor, push_cursor, kind FROM peers WHERE url='http://x'")
    .get() as { pull_cursor: number; push_cursor: number; kind: string };
  expect(row.pull_cursor).toBe(5); // cursors survive the migration
  expect(row.push_cursor).toBe(7);
  expect(row.kind).toBe("http"); // existing rows backfill to the default transport
});

test("migratePeers is idempotent (running twice is a no-op)", () => {
  const db = new Database(":memory:");
  runSchema(db); // already-current schema
  expect(() => {
    migratePeers(db);
    migratePeers(db);
  }).not.toThrow();
  expect(hasCol(db, "peers", "config")).toBe(true);
});

test("migrateCrdtChangesSeq rebuilds a legacy oplog with a stable AUTOINCREMENT seq", () => {
  const db = new Database(":memory:");
  // Legacy shape: composite PK, no `seq`, so rowid is the implicit (and
  // VACUUM-renumberable) one the cursor bug rode on.
  db.exec(`CREATE TABLE crdt_changes (
    hlc TEXT NOT NULL, node_id TEXT NOT NULL, dataset TEXT NOT NULL,
    row_id TEXT NOT NULL, col TEXT NOT NULL, value TEXT, txn TEXT,
    PRIMARY KEY (dataset, row_id, col, hlc)
  )`);
  db.exec("CREATE TABLE peers (url TEXT PRIMARY KEY, pull_cursor INTEGER, push_cursor INTEGER)");
  db.query("INSERT INTO peers (url, pull_cursor, push_cursor) VALUES ('http://x', 9, 9)").run();
  const ins = db.query(
    "INSERT INTO crdt_changes (hlc, node_id, dataset, row_id, col, value) VALUES (?,?,?,?,?,?)",
  );
  for (let i = 0; i < 3; i++) ins.run(`00000000000000${i}-0000-n`, "n", "d", `r${i}`, "c", `${i}`);

  expect(hasCol(db, "crdt_changes", "seq")).toBe(false);
  migrateCrdtChangesSeq(db);

  expect(hasCol(db, "crdt_changes", "seq")).toBe(true);
  const rows = db.query("SELECT seq, row_id FROM crdt_changes ORDER BY seq").all() as {
    seq: number;
    row_id: string;
  }[];
  expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]); // old rowids copied verbatim
  // A fresh insert continues the sequence — never reused/renumbered.
  ins.run("0000000000000099-0000-n", "n", "d", "r9", "c", "9");
  expect((db.query("SELECT MAX(seq) AS m FROM crdt_changes").get() as { m: number }).m).toBe(4);
  // Dedup still works via the UNIQUE(dataset,row_id,col,hlc) constraint.
  db.query(
    "INSERT OR IGNORE INTO crdt_changes (hlc, node_id, dataset, row_id, col, value) VALUES (?,?,?,?,?,?)",
  ).run("0000000000000099-0000-n", "n", "d", "r9", "c", "dupe");
  expect((db.query("SELECT COUNT(*) AS n FROM crdt_changes").get() as { n: number }).n).toBe(4);
  // Cursors reset: we can't tell which a past VACUUM already stranded.
  const p = db.query("SELECT pull_cursor, push_cursor FROM peers WHERE url='http://x'").get() as {
    pull_cursor: number;
    push_cursor: number;
  };
  expect(p.pull_cursor).toBe(0);
  expect(p.push_cursor).toBe(0);
});

test("migrateCrdtChangesSeq is idempotent on the current schema", () => {
  const db = new Database(":memory:");
  runSchema(db); // already has seq
  expect(() => {
    migrateCrdtChangesSeq(db);
    migrateCrdtChangesSeq(db);
  }).not.toThrow();
  expect(hasCol(db, "crdt_changes", "seq")).toBe(true);
});
