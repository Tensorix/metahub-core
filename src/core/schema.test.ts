import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, migrateOplog, migrateCrdtChangesSeq, migrateDatabases } from "./schema-init.ts";
import { runSchema } from "./db.ts";
import { emit, changesAfterSeq, CHANGE_COLS } from "./crdt.ts";
import { DATABASE_COLS } from "./databases.ts";
import { PROPERTY_COLS } from "./properties.ts";
import { DOCUMENT_COLS } from "./documents.ts";
import { SITE_COLS, SITE_FILE_COLS } from "./sites-core.ts";

// Schema contract: the row interfaces (via their exported column lists) must
// stay a subset of the real tables. The lists themselves are compile-time
// locked to the interfaces (sqlcols.ts ColumnsOf), so this closes the loop:
//   interface ⇄ column list (tsc) + column list ⊆ table (here).

function makeNode(id: string): Database {
  const db = new Database(":memory:");
  initSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return db;
}

function tableColumns(db: Database, table: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

// Tables without an exported interface-locked list: assert the columns their
// readers/writers rely on, written out here as the contract.
const EXPECTED: [table: string, cols: readonly string[]][] = [
  ["databases", DATABASE_COLS],
  ["properties", PROPERTY_COLS],
  ["documents", DOCUMENT_COLS],
  ["sites", SITE_COLS],
  ["site_files", SITE_FILE_COLS],
  ["crdt_changes", CHANGE_COLS],
  ["records", ["id", "database_id", "created_hlc", "order_key", "data"]],
  ["doc_blocks", ["id", "doc_id", "text", "order_key", "blank_after"]],
];

test("every row interface's columns exist in its table", () => {
  const db = makeNode("aaaa");
  for (const [table, cols] of EXPECTED) {
    const actual = tableColumns(db, table);
    for (const col of cols) {
      expect(actual.has(col), `${table}.${col} missing from PRAGMA table_info`).toBe(true);
    }
  }
});

test("domain tables keep their tombstone column", () => {
  const db = makeNode("aaaa");
  for (const table of ["databases", "properties", "records", "documents", "doc_blocks", "sites", "site_files"]) {
    expect(tableColumns(db, table).has("__deleted"), `${table}.__deleted`).toBe(true);
  }
});

// The CREATE in schema.ts and the guarded migrations in schema-init.ts are two
// sources of truth for the same end state; this pins them together for the
// table that has both (crdt_changes gained `txn` by ALTER and `seq` by rebuild).
test("fresh CREATE and legacy-table migration agree on crdt_changes columns", () => {
  const fresh = new Database(":memory:");
  runSchema(fresh);

  const legacy = new Database(":memory:");
  legacy.exec(`
    CREATE TABLE crdt_changes (
      hlc     TEXT NOT NULL,
      node_id TEXT NOT NULL,
      dataset TEXT NOT NULL,
      row_id  TEXT NOT NULL,
      col     TEXT NOT NULL,
      value   TEXT,
      PRIMARY KEY (dataset, row_id, col, hlc)
    );
  `);
  migrateOplog(legacy); // adds txn
  migrateCrdtChangesSeq(legacy); // rebuilds with the AUTOINCREMENT seq

  expect([...tableColumns(legacy, "crdt_changes")].sort()).toEqual(
    [...tableColumns(fresh, "crdt_changes")].sort(),
  );
});

// Runtime canary for SELECT drift: a change read back through the replication
// path must carry every key of the Change interface.
test("changesAfterSeq returns every Change column", () => {
  const db = makeNode("aaaa");
  emit(db, "databases", "db_probe-zzzzzz", "name", "probe");
  const change = changesAfterSeq(db, 0).changes[0]!;
  for (const col of CHANGE_COLS) {
    expect(col in change, `Change.${col} missing from changesAfterSeq row`).toBe(true);
  }
});

// Upgrade re-materialization: an OLD binary that pulled `databases/meta`
// changes stored them in crdt_changes but never materialized (unknown column)
// and advanced its pull cursor past them. Adding the column must backfill each
// database's meta from the WINNING (max-HLC) oplog change — otherwise the
// value is stranded in the oplog forever.
test("migrateDatabases backfills meta from already-pulled oplog changes", () => {
  const legacy = new Database(":memory:");
  runSchema(legacy);
  // Simulate the pre-meta table: rebuild `databases` without the column.
  legacy.exec(`
    DROP TABLE databases;
    CREATE TABLE databases (
      id TEXT PRIMARY KEY, name TEXT, icon TEXT, created_hlc TEXT, __deleted INTEGER
    );
    INSERT INTO databases (id, name) VALUES ('db_1', 'A'), ('db_2', 'B');
  `);
  // Changes an old binary pulled and skipped (two revisions for db_1 — the
  // max-HLC one must win; none for db_2).
  const ins = legacy.query(
    "INSERT INTO crdt_changes (hlc, node_id, dataset, row_id, col, value) VALUES (?, 'peer', 'databases', ?, 'meta', ?)",
  );
  ins.run("0002-aaaa", "db_1", JSON.stringify({ collapsed: true }));
  ins.run("0005-aaaa", "db_1", JSON.stringify({ collapsed: false, tag: "site" }));

  migrateDatabases(legacy);

  const rows = legacy.query("SELECT id, meta FROM databases ORDER BY id").all() as { id: string; meta: string | null }[];
  expect(JSON.parse(rows[0]!.meta!)).toEqual({ collapsed: false, tag: "site" });
  expect(rows[1]!.meta).toBeNull();

  // Idempotent: a second run (column now present) is a no-op.
  legacy.query("UPDATE databases SET meta = NULL WHERE id = 'db_1'").run();
  migrateDatabases(legacy);
  expect((legacy.query("SELECT meta FROM databases WHERE id = 'db_1'").get() as { meta: string | null }).meta).toBeNull();
});
