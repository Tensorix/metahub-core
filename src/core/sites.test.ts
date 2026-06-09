import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import { ingest, changesSince } from "./crdt.ts";
import {
  createSite,
  getSite,
  getSiteByName,
  listSites,
  updateSite,
  deleteSite,
  resolveSite,
  putFile,
  listFiles,
  deleteFile,
  getFileForServe,
  inferContentType,
} from "./sites.ts";

function makeNode(id: string): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return db;
}

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

test("create / get / list / resolve by name and id", () => {
  const db = makeNode("n1");
  const site = createSite(db, { name: "demo", title: "Demo" });
  expect(site.id.startsWith("site_")).toBe(true);
  expect(getSite(db, site.id)?.name).toBe("demo");
  expect(getSiteByName(db, "demo")?.id).toBe(site.id);
  expect(listSites(db).length).toBe(1);
  expect(resolveSite(db, "demo").id).toBe(site.id);
  expect(resolveSite(db, site.id).id).toBe(site.id);
  expect(() => resolveSite(db, "nope")).toThrow();
});

test("duplicate live site name is rejected", () => {
  const db = makeNode("n1");
  createSite(db, { name: "demo" });
  expect(() => createSite(db, { name: "demo" })).toThrow();
});

test("updateSite renames and changes title; guards duplicate names", () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo", title: "Demo" });
  createSite(db, { name: "taken" });

  const renamed = updateSite(db, s.id, { name: "docs", title: "产品官网" });
  expect(renamed.name).toBe("docs");
  expect(renamed.title).toBe("产品官网");
  expect(getSiteByName(db, "docs")?.id).toBe(s.id);

  // changing only the title leaves the name intact
  expect(updateSite(db, s.id, { title: "新标题" }).name).toBe("docs");

  // renaming onto an existing live name is rejected
  expect(() => updateSite(db, s.id, { name: "taken" })).toThrow();
  // updating a missing site throws
  expect(() => updateSite(db, "site_missing", { title: "x" })).toThrow();
});

test("text files store as utf8 and round-trip via getFileForServe", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  const f = await putFile(db, s.id, "index.html", { data: "<h1>hi</h1>" });
  expect(f.encoding).toBe("utf8");
  expect(f.content_type).toContain("text/html");

  const served = await getFileForServe(db, s.id, "index.html");
  expect(dec(served!.bytes)).toBe("<h1>hi</h1>");
  expect(served!.contentType).toContain("text/html");
});

test('"" and trailing slash resolve to index.html', async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  await putFile(db, s.id, "index.html", { data: "<h1>root</h1>" });
  await putFile(db, s.id, "sub/index.html", { data: "<h1>sub</h1>" });
  expect(dec((await getFileForServe(db, s.id, ""))!.bytes)).toBe("<h1>root</h1>");
  expect(dec((await getFileForServe(db, s.id, "sub/"))!.bytes)).toBe("<h1>sub</h1>");
  expect(await getFileForServe(db, s.id, "missing/")).toBeNull();
});

test("binary files store inline as base64 and round-trip", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const f = await putFile(db, s.id, "img/logo.png", { data: png });
  expect(f.encoding).toBe("base64");
  expect(f.content_type).toBe("image/png");

  const served = await getFileForServe(db, s.id, "img/logo.png");
  expect(Array.from(served!.bytes)).toEqual(Array.from(png));
});

test("re-uploading a path merges into the same row (upsert, no duplicate)", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  const first = await putFile(db, s.id, "app.css", { data: "a{}" });
  const second = await putFile(db, s.id, "app.css", { data: "b{}" });
  expect(second.id).toBe(first.id);
  expect(listFiles(db, s.id).length).toBe(1);
  expect(dec((await getFileForServe(db, s.id, "app.css"))!.bytes)).toBe("b{}");
});

test("deleteFile hides a file; re-upload un-deletes", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  await putFile(db, s.id, "x.txt", { data: "one" });
  expect(deleteFile(db, s.id, "x.txt")).toBe(true);
  expect(await getFileForServe(db, s.id, "x.txt")).toBeNull();
  expect(listFiles(db, s.id).length).toBe(0);
  await putFile(db, s.id, "x.txt", { data: "two" });
  expect(dec((await getFileForServe(db, s.id, "x.txt"))!.bytes)).toBe("two");
});

test("deleteSite cascades to files", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  await putFile(db, s.id, "index.html", { data: "<p>x</p>" });
  expect(deleteSite(db, s.id)).toBe(true);
  expect(getSite(db, s.id)).toBeNull();
  expect(listSites(db).length).toBe(0);
  expect(listFiles(db, s.id).length).toBe(0);
});

test("inferContentType maps common extensions", () => {
  expect(inferContentType("a/b.html")).toContain("text/html");
  expect(inferContentType("x.css")).toContain("text/css");
  expect(inferContentType("y.png")).toBe("image/png");
  expect(inferContentType("z.unknown")).toBe("application/octet-stream");
});

test("a site and its inline files replicate to another node via the oplog", async () => {
  const a = makeNode("a");
  const b = makeNode("b");
  const s = createSite(a, { name: "demo", title: "Demo" });
  await putFile(a, s.id, "index.html", { data: "<h1>synced</h1>" });

  ingest(b, changesSince(a, ""));

  expect(getSiteByName(b, "demo")?.id).toBe(s.id);
  const served = await getFileForServe(b, s.id, "");
  expect(dec(served!.bytes)).toBe("<h1>synced</h1>");
});
