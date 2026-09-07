import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "./schema-init.ts";
import { DOMAIN } from "./crdt.ts";
import { PARTITION_DATASETS } from "./sync/partition.ts";
import { TABLES, SYNCED_TABLES, CONTENT_TABLES, SYSTEM_DATASETS } from "./tables.ts";

// The registry IS the boundary: every real table must be declared with a tier,
// and the "synced" flag must agree with crdt.ts's DOMAIN materializer.

function realTables(db: Database): Set<string> {
  const rows = db.query("PRAGMA table_list").all() as { schema: string; name: string; type: string }[];
  return new Set(
    rows
      .filter((r) => r.schema === "main" && (r.type === "table" || r.type === "virtual"))
      .map((r) => r.name)
      // sqlite internals + the FTS5 shadow tables behind search_fts
      .filter((n) => !n.startsWith("sqlite_") && !n.startsWith("search_fts_")),
  );
}

test("every table in the schema is registered in tables.ts, and vice versa", () => {
  const db = new Database(":memory:");
  initSchema(db);
  expect([...realTables(db)].sort()).toEqual(Object.keys(TABLES).sort());
});

test("DOMAIN (plus the special-cased records dataset) is exactly the synced tier", () => {
  const domain = new Set([...Object.keys(DOMAIN), "records"]);
  expect([...domain].sort()).toEqual([...SYNCED_TABLES].sort());
  for (const [ds, d] of Object.entries(DOMAIN)) expect(d.table).toBe(ds);
});

test("every synced table carries a tombstone column", () => {
  const db = new Database(":memory:");
  initSchema(db);
  for (const t of SYNCED_TABLES) {
    const cols = (db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols, `${t}.__deleted`).toContain("__deleted");
  }
});

test("share partitions only ever carry content-tier datasets", () => {
  for (const ds of PARTITION_DATASETS) expect(CONTENT_TABLES).toContain(ds);
  for (const ds of SYSTEM_DATASETS) expect(PARTITION_DATASETS as readonly string[]).not.toContain(ds);
});
