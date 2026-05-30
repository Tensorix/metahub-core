import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import { createDatabase } from "./databases.ts";
import {
  addProperty,
  getProperty,
  listProperties,
  updateProperty,
  removeProperty,
} from "./properties.ts";
import { createRecord, getRecord } from "./records.ts";

function newDb(node = "test-node"): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(node);
  return db;
}

test("updateProperty renames, edits config, and reorders", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  const p = addProperty(db, d.id, { name: "Status", type: "select", config: { options: ["todo", "done"] } });

  const renamed = updateProperty(db, p.id, { name: "State" });
  expect(renamed.name).toBe("State");

  const recfg = updateProperty(db, p.id, { config: { options: ["todo", "doing", "done"] } });
  expect(recfg.config?.options).toEqual(["todo", "doing", "done"]);

  const moved = updateProperty(db, p.id, { position: 5 });
  expect(moved.position).toBe(5);
});

test("changing a property's type clears existing cell values", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  const title = addProperty(db, d.id, { name: "Title", type: "text" });
  const count = addProperty(db, d.id, { name: "Count", type: "number" });

  const rec = createRecord(db, d.id, { Title: "hi", Count: 42 });
  expect(getRecord(db, rec.id)!.values.Count).toBe(42);

  // number -> text keeps the column but the prior value is no longer present
  const changed = updateProperty(db, count.id, { type: "text" });
  expect(changed.type).toBe("text");
  expect(getRecord(db, rec.id)!.values.Count ?? null).toBeNull();
  // unrelated cell is untouched
  expect(getRecord(db, rec.id)!.values.Title).toBe("hi");
  expect(title).toBeTruthy();
});

test("changing to select without options is rejected", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  const p = addProperty(db, d.id, { name: "Count", type: "number" });
  expect(() => updateProperty(db, p.id, { type: "select" })).toThrow(/options/);
});

test("removeProperty drops the column from listings", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  const p = addProperty(db, d.id, { name: "Title", type: "text" });
  expect(removeProperty(db, p.id)).toBe(true);
  expect(getProperty(db, p.id)).toBeNull();
  expect(listProperties(db, d.id).length).toBe(0);
});
