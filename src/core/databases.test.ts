import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import {
  createDatabase,
  getDatabase,
  updateDatabase,
  deleteDatabase,
} from "./databases.ts";

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
