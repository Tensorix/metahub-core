import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import {
  createDatabase,
  getDatabase,
  updateDatabase,
  duplicateDatabase,
  deleteDatabase,
} from "./databases.ts";
import { addProperty, listProperties } from "./properties.ts";
import { createRecord, listRecords } from "./records.ts";

function newDb(node = "test-node"): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(node);
  return db;
}

test("updateDatabase renames and changes icon", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks", icon: "✅" });

  const renamed = updateDatabase(db, d.id, { name: "Projects" });
  expect(renamed.name).toBe("Projects");
  expect(renamed.icon).toBe("✅");

  const reicon = updateDatabase(db, d.id, { icon: "📁" });
  expect(reicon.icon).toBe("📁");
  expect(reicon.name).toBe("Projects");

  // clearing the icon
  const cleared = updateDatabase(db, d.id, { icon: null });
  expect(cleared.icon).toBeNull();
});

test("duplicateDatabase copies schema (order/type) and all records", () => {
  const db = newDb();
  const src = createDatabase(db, { name: "Tasks", icon: "✅" });
  addProperty(db, src.id, { name: "Title", type: "text" });
  addProperty(db, src.id, { name: "Points", type: "number" });
  createRecord(db, src.id, { Title: "First", Points: 1 });
  createRecord(db, src.id, { Title: "Second", Points: 2 });

  const dup = duplicateDatabase(db, src.id, { name: "Tasks 副本" });
  expect(dup.id).not.toBe(src.id);
  expect(dup.name).toBe("Tasks 副本");
  expect(dup.icon).toBe("✅");

  const props = listProperties(db, dup.id);
  expect(props.map((p) => [p.name, p.type])).toEqual([
    ["Title", "text"],
    ["Points", "number"],
  ]);

  const recs = listRecords(db, dup.id);
  expect(recs.map((r) => r.values["Title"])).toEqual(["First", "Second"]);
  expect(recs.map((r) => r.values["Points"])).toEqual([1, 2]);

  // Independent copy: a new record in the source must not appear in the copy.
  createRecord(db, src.id, { Title: "Third" });
  expect(listRecords(db, dup.id).length).toBe(2);
});

test("duplicateDatabase remaps a self-referential relation to the copy", () => {
  const db = newDb();
  const src = createDatabase(db, { name: "People" });
  addProperty(db, src.id, { name: "Name", type: "text" });
  addProperty(db, src.id, { name: "Manager", type: "relation", config: { database: src.id } });

  const dup = duplicateDatabase(db, src.id);
  const rel = listProperties(db, dup.id).find((p) => p.name === "Manager")!;
  expect(rel.config?.database).toBe(dup.id);
});

test("duplicateDatabase defaults the name to the source and throws when missing", () => {
  const db = newDb();
  const src = createDatabase(db, { name: "Tasks" });
  expect(duplicateDatabase(db, src.id).name).toBe("Tasks");
  expect(() => duplicateDatabase(db, "db_missing")).toThrow(/no such database/);
});

test("updateDatabase throws for a missing database", () => {
  const db = newDb();
  expect(() => updateDatabase(db, "db_missing", { name: "x" })).toThrow(/no such database/);
});

test("deleteDatabase soft-deletes and clears the current pointer", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('current_db', ?)").run(d.id);

  expect(deleteDatabase(db, d.id)).toBe(true);
  expect(getDatabase(db, d.id)).toBeNull();
  const cur = db.query("SELECT value FROM meta WHERE key = 'current_db'").get() as
    | { value: string }
    | null;
  expect(cur).toBeNull();
  // deleting again is a no-op
  expect(deleteDatabase(db, d.id)).toBe(false);
});

test("meta is a generic replicated JSON register (round-trip, clear, duplicate)", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  expect(d.meta).toBeNull();

  const set = updateDatabase(db, d.id, { meta: { collapsed: true, tag: "site" } });
  expect(set.meta).toEqual({ collapsed: true, tag: "site" });
  expect(getDatabase(db, d.id)!.meta).toEqual({ collapsed: true, tag: "site" });

  // whole-object register: an update replaces, callers merge beforehand
  const replaced = updateDatabase(db, d.id, { meta: { collapsed: false } });
  expect(replaced.meta).toEqual({ collapsed: false });

  // a duplicate carries the source's meta
  const dup = duplicateDatabase(db, d.id, { name: "Copy" });
  expect(dup.meta).toEqual({ collapsed: false });

  const cleared = updateDatabase(db, d.id, { meta: null });
  expect(cleared.meta).toBeNull();

  // non-object meta is rejected
  expect(() => updateDatabase(db, d.id, { meta: [1] as unknown as Record<string, unknown> })).toThrow();
});
