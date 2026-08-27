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

test("CSV exports relation cells as titles (id fallback) and imports them back", async () => {
  const db = newDb();
  const projects = createDatabase(db, { name: "Projects" });
  addProperty(db, projects.id, { name: "Name", type: "text" });
  const alpha = createRecord(db, projects.id, { Name: "Alpha" });
  const beta = createRecord(db, projects.id, { Name: "Beta" });

  const tasks = createDatabase(db, { name: "Tasks" });
  addProperty(db, tasks.id, { name: "Title", type: "text" });
  addProperty(db, tasks.id, { name: "Project", type: "relation", config: { database: projects.id } });
  const rec = createRecord(db, tasks.id, { Title: "t1", Project: [alpha.id, "rec_ghost-000000"] });

  const path = tmpPath("tasks.csv");
  await syncFiles(db, tasks.id, path);
  const csv = await Bun.file(path).text();
  // titles joined with ", " (quoted by the CSV layer); dangling id falls back raw
  expect(csv).toContain('"Alpha, rec_ghost-000000"');
  expect(csv).not.toContain(alpha.id);

  // Round-trip: same file back in — titles resolve to ids, count stays put.
  const res = await syncFiles(db, path, tasks.id);
  expect(res).toMatchObject({ direction: "import", kind: "db", rows: 1 });
  expect(listRecords(db, tasks.id, {}).length).toBe(1);

  // Human edit: retarget by title.
  await Bun.write(path, `id,Title,Project\n${rec.id},t1,Beta\n`);
  await syncFiles(db, path, tasks.id);
  expect(listRecords(db, tasks.id, {})[0]!.values.Project).toEqual([beta.id]);

  // Legacy JSON-array-of-ids cells still import.
  await Bun.write(path, `id,Title,Project\n${rec.id},t1,"[""${alpha.id}""]"\n`);
  await syncFiles(db, path, tasks.id);
  expect(listRecords(db, tasks.id, {})[0]!.values.Project).toEqual([alpha.id]);

  // Ambiguous titles fail loudly instead of guessing.
  createRecord(db, projects.id, { Name: "Beta" });
  await Bun.write(path, `id,Title,Project\n${rec.id},t1,Beta\n`);
  await expect(syncFiles(db, path, tasks.id)).rejects.toThrow(/ambiguous/);
});

test("relation titles containing commas round-trip without retargeting", async () => {
  const db = newDb();
  const projects = createDatabase(db, { name: "Projects" });
  addProperty(db, projects.id, { name: "Name", type: "text" });
  const combo = createRecord(db, projects.id, { Name: "Foo, Bar" });
  const alpha = createRecord(db, projects.id, { Name: "Alpha" });
  // Decoys: if "Foo, Bar" ever mis-split, these would silently absorb the halves.
  createRecord(db, projects.id, { Name: "Foo" });
  createRecord(db, projects.id, { Name: "Bar" });

  const tasks = createDatabase(db, { name: "Tasks" });
  addProperty(db, tasks.id, { name: "Title", type: "text" });
  addProperty(db, tasks.id, { name: "Project", type: "relation", config: { database: projects.id } });
  createRecord(db, tasks.id, { Title: "t1", Project: [combo.id, alpha.id] });

  const path = tmpPath("comma.csv");
  await syncFiles(db, tasks.id, path);
  const csv = await Bun.file(path).text();
  // codec quotes the comma title, then the CSV layer quotes the whole cell
  expect(csv).toContain('""Foo, Bar""');

  await syncFiles(db, path, tasks.id);
  expect(listRecords(db, tasks.id, {})[0]!.values.Project).toEqual([combo.id, alpha.id]);

  // Hand-authored quoted form resolves too (cell hand-written as CSV text).
  const rec = listRecords(db, tasks.id, {})[0]!;
  await Bun.write(path, `id,Title,Project\n${rec.id},t1,"Alpha, ""Foo, Bar"""\n`);
  await syncFiles(db, path, tasks.id);
  expect(listRecords(db, tasks.id, {})[0]!.values.Project).toEqual([alpha.id, combo.id]);
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

test("CSV exports doc cells as titles (id fallback) and imports them back", async () => {
  const db = newDb();
  const spec = createDocument(db, { title: "设计说明" });
  const other = createDocument(db, { title: "会议纪要" });

  const tasks = createDatabase(db, { name: "Tasks" });
  addProperty(db, tasks.id, { name: "Title", type: "text" });
  addProperty(db, tasks.id, { name: "Docs", type: "doc" });
  const rec = createRecord(db, tasks.id, { Title: "t1", Docs: [spec.id, "doc_ghost-000000"] });

  const path = tmpPath("tasks-docs.csv");
  await syncFiles(db, tasks.id, path);
  const csv = await Bun.file(path).text();
  // titles joined with ", "; dangling id falls back raw
  expect(csv).toContain('"设计说明, doc_ghost-000000"');
  expect(csv).not.toContain(spec.id);

  // Round-trip: titles resolve back to ids, count stays put.
  const res = await syncFiles(db, path, tasks.id);
  expect(res).toMatchObject({ direction: "import", kind: "db", rows: 1 });
  expect(listRecords(db, tasks.id, {})[0]!.values.Docs).toEqual([spec.id, "doc_ghost-000000"]);

  // Human edit: retarget by title.
  await Bun.write(path, `id,Title,Docs\n${rec.id},t1,会议纪要\n`);
  await syncFiles(db, path, tasks.id);
  expect(listRecords(db, tasks.id, {})[0]!.values.Docs).toEqual([other.id]);
});
