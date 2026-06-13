import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema, migratePeers } from "./schema-init.ts";

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
