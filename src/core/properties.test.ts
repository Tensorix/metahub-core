import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import { createDatabase } from "./databases.ts";
import {
  addProperty,
  getProperty,
  listProperties,
  updateProperty,
  setPropertyWidth,
  removeProperty,
  renameSelectOption,
  removeSelectOption,
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

test("setPropertyWidth persists, clamps, and preserves sibling config", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  const p = addProperty(db, d.id, { name: "Status", type: "select", config: { options: ["todo", "done"] } });

  const sized = setPropertyWidth(db, p.id, 240);
  expect(sized.config?.width).toBe(240);
  // merge must not strip the select's options
  expect(sized.config?.width !== undefined && getProperty(db, p.id)!.config?.options).toEqual(["todo", "done"]);

  // below the floor is clamped to 80, above the ceiling to 2000
  expect(setPropertyWidth(db, p.id, 10).config?.width).toBe(80);
  expect(setPropertyWidth(db, p.id, 9999).config?.width).toBe(2000);

  // non-finite is rejected
  expect(() => setPropertyWidth(db, p.id, NaN)).toThrow();
});

test("updateProperty merges config patches and preserves sibling keys", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  const p = addProperty(db, d.id, { name: "Status", type: "select", config: { options: ["todo", "done"], width: 240 } });

  // an options-only patch must not strip the column width
  const patched = updateProperty(db, p.id, { config: { options: ["todo", "doing", "done"] } });
  expect(patched.config?.options).toEqual(["todo", "doing", "done"]);
  expect(patched.config?.width).toBe(240);

  // a key explicitly set to null is removed
  const cleared = updateProperty(db, p.id, { config: { width: null as unknown as number } });
  expect(cleared.config?.width).toBeUndefined();
  expect(cleared.config?.options).toEqual(["todo", "doing", "done"]);

  // the merged result is validated: nulling options off a select is rejected
  expect(() => updateProperty(db, p.id, { config: { options: null as unknown as string[] } })).toThrow(/options/);
});

test("renameSelectOption rewrites select cells and preserves config", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  const p = addProperty(db, d.id, { name: "Status", type: "select", config: { options: ["todo", "done"], width: 240 } });
  const r1 = createRecord(db, d.id, { Status: "todo" });
  const r2 = createRecord(db, d.id, { Status: "done" });
  const r3 = createRecord(db, d.id, {});

  const res = renameSelectOption(db, p.id, "todo", "doing");
  expect(res.renamed).toBe(1);
  expect(res.property.config?.options).toEqual(["doing", "done"]); // order kept
  expect(res.property.config?.width).toBe(240); // sibling key kept
  expect(getRecord(db, r1.id)!.values.Status).toBe("doing");
  expect(getRecord(db, r2.id)!.values.Status).toBe("done"); // untouched
  expect(getRecord(db, r3.id)!.values.Status ?? null).toBeNull();
});

test("renameSelectOption rewrites multi_select array elements", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  const p = addProperty(db, d.id, { name: "Tags", type: "multi_select", config: { options: ["a", "b", "c"] } });
  const r1 = createRecord(db, d.id, { Tags: ["a", "b"] });
  const r2 = createRecord(db, d.id, { Tags: ["c"] });

  const res = renameSelectOption(db, p.id, "a", "x");
  expect(res.renamed).toBe(1);
  expect(getRecord(db, r1.id)!.values.Tags).toEqual(["x", "b"]); // element replaced in place
  expect(getRecord(db, r2.id)!.values.Tags).toEqual(["c"]);
});

test("renameSelectOption validates inputs", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  const text = addProperty(db, d.id, { name: "Title", type: "text" });
  const p = addProperty(db, d.id, { name: "Status", type: "select", config: { options: ["todo", "done"] } });

  expect(() => renameSelectOption(db, "prop_missing", "a", "b")).toThrow(/no such property/);
  expect(() => renameSelectOption(db, text.id, "a", "b")).toThrow(/has no options/);
  expect(() => renameSelectOption(db, p.id, "nope", "b")).toThrow(/no such option/);
  expect(() => renameSelectOption(db, p.id, "todo", "  ")).toThrow(/empty/);
  expect(() => renameSelectOption(db, p.id, "todo", "done")).toThrow(/already exists/);
  // no-op rename returns zero effect and leaves options untouched
  const noop = renameSelectOption(db, p.id, "todo", "todo");
  expect(noop.renamed).toBe(0);
  expect(noop.property.config?.options).toEqual(["todo", "done"]);
});

test("removeSelectOption clears cells that used the option", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  const sel = addProperty(db, d.id, { name: "Status", type: "select", config: { options: ["todo", "done"] } });
  const tags = addProperty(db, d.id, { name: "Tags", type: "multi_select", config: { options: ["a", "b"] } });
  const r1 = createRecord(db, d.id, { Status: "todo", Tags: ["a", "b"] });
  const r2 = createRecord(db, d.id, { Status: "done", Tags: ["b"] });

  const res = removeSelectOption(db, sel.id, "todo");
  expect(res.cleared).toBe(1);
  expect(res.property.config?.options).toEqual(["done"]);
  expect(getRecord(db, r1.id)!.values.Status ?? null).toBeNull();
  expect(getRecord(db, r2.id)!.values.Status).toBe("done");

  const res2 = removeSelectOption(db, tags.id, "a");
  expect(res2.cleared).toBe(1);
  expect(getRecord(db, r1.id)!.values.Tags).toEqual(["b"]);
  expect(getRecord(db, r2.id)!.values.Tags).toEqual(["b"]);

  // the last option cannot be removed — a select must keep a non-empty set
  expect(() => removeSelectOption(db, sel.id, "done")).toThrow(/last option/);
  expect(() => removeSelectOption(db, sel.id, "gone")).toThrow(/no such option/);
});

test("removeProperty drops the column from listings", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  const p = addProperty(db, d.id, { name: "Title", type: "text" });
  expect(removeProperty(db, p.id)).toBe(true);
  expect(getProperty(db, p.id)).toBeNull();
  expect(listProperties(db, d.id).length).toBe(0);
});

test("doc properties need no config and index eagerly", () => {
  const db = newDb();
  const d = createDatabase(db, { name: "Tasks" });
  const p = addProperty(db, d.id, { name: "参考文档", type: "doc" });
  expect(p.type).toBe("doc");
  expect(p.config).toBeNull();
  // eager index exists (same policy as relation)
  const idx = db
    .query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND sql LIKE ?")
    .get(`%'${p.id}'%`);
  expect(idx).not.toBeNull();
});
