import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSchema } from "../db.ts";
import { createDatabase } from "../databases.ts";
import { addProperty } from "../properties.ts";
import { createRecord, listRecords } from "../records.ts";
import { createDocument, getDocument } from "../documents.ts";
import { syncFiles } from "./files.ts";

function newDb(): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run("test-node");
  return db;
}

function tmpPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "mh-sync-")), name);
}

test("export doc → markdown, then import markdown → doc round-trips", async () => {
  const db = newDb();
  const doc = createDocument(db, { title: "Arch", body: "# Title\n\nfirst\n\nsecond" });
  const path = tmpPath("arch.md");

  const out = await syncFiles(db, doc.id, path);
  expect(out).toMatchObject({ direction: "export", kind: "doc", id: doc.id });
  expect(await Bun.file(path).text()).toBe("# Title\n\nfirst\n\nsecond");

  await Bun.write(path, "# Title\n\nrewritten body");
  const back = await syncFiles(db, path, doc.id);
  expect(back).toMatchObject({ direction: "import", kind: "doc", id: doc.id });
  expect(getDocument(db, doc.id)!.body).toBe("# Title\n\nrewritten body");
});

test("export table → CSV captures header and rows", async () => {
  const db = newDb();
  const tasks = createDatabase(db, { name: "Tasks" });
  addProperty(db, tasks.id, { name: "Title", type: "text" });
  addProperty(db, tasks.id, { name: "Done", type: "checkbox" });
  createRecord(db, tasks.id, { Title: "a, b", Done: false });
  createRecord(db, tasks.id, { Title: "two", Done: true });

  const path = tmpPath("tasks.csv");
  const out = await syncFiles(db, tasks.id, path);
  expect(out).toMatchObject({ direction: "export", kind: "db", rows: 2 });

  const csv = await Bun.file(path).text();
  const lines = csv.split("\n");
  expect(lines[0]).toBe("id,Title,Done");
  expect(csv).toContain('"a, b"');
  expect(csv).toContain("true");
});

test("CSV round-trips multi_select arrays without duplicating rows", async () => {
  const db = newDb();
  const t = createDatabase(db, { name: "Items" });
  addProperty(db, t.id, { name: "Name", type: "text" });
  addProperty(db, t.id, {
    name: "Tags",
    type: "multi_select",
    config: { options: ["x", "y", "z"] },
  });
  createRecord(db, t.id, { Name: "one", Tags: ["x", "y"] });

  const path = tmpPath("items.csv");
  await syncFiles(db, t.id, path);

  // Re-import: the exported `id` column upserts, so the count stays at 1.
  const res = await syncFiles(db, path, t.id);
  expect(res).toMatchObject({ direction: "import", kind: "db", rows: 1 });
  const rows = listRecords(db, t.id, {});
  expect(rows.length).toBe(1);
  expect(rows[0]!.values.Tags).toEqual(["x", "y"]);
});

test("rejects refs that are neither doc nor table", async () => {
  const db = newDb();
  const t = createDatabase(db, { name: "Tasks" });
  addProperty(db, t.id, { name: "Title", type: "text" });
  const rec = createRecord(db, t.id, { Title: "x" });
  await expect(syncFiles(db, rec.id, tmpPath("r.csv"))).rejects.toThrow(/only documents and data tables/);
});

test("errors when neither side resolves to an entity", async () => {
  const db = newDb();
  await expect(syncFiles(db, "nope", "also-nope.md")).rejects.toThrow(/neither/);
});
