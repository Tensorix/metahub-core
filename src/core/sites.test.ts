import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  putFileInline,
  fileCount,
  listFiles,
  deleteFile,
  getFileForServe,
  inferContentType,
  normalizeSiteName,
  normalizeSitePath,
} from "./sites.ts";

function makeNode(id: string): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return db;
}

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// Isolate blob writes (images / large binaries hit cache.ts → METAHUB_HOME/cache)
// into a throwaway dir so tests never touch the real ~/.metahub.
const ORIGINAL_HOME = process.env.METAHUB_HOME;
let TMP_HOME: string;
beforeAll(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), "mh-sites-"));
  process.env.METAHUB_HOME = TMP_HOME;
});
afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.METAHUB_HOME;
  else process.env.METAHUB_HOME = ORIGINAL_HOME;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

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

test("normalizeSiteName slugifies and rejects empty results", () => {
  expect(normalizeSiteName("My Blog")).toBe("my-blog");
  expect(normalizeSiteName("  Docs!! ")).toBe("docs");
  expect(normalizeSiteName("a/b")).toBe("a-b");
  expect(normalizeSiteName("--Hi--")).toBe("hi");
  expect(() => normalizeSiteName("")).toThrow();
  expect(() => normalizeSiteName("///")).toThrow();
});

test("createSite stores the canonical slug; lookups are case-insensitive", () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "My Blog", title: "Blog" });
  expect(s.name).toBe("my-blog");
  expect(getSiteByName(db, "My Blog")?.id).toBe(s.id);
  expect(resolveSite(db, "MY-BLOG").id).toBe(s.id);
  // a name that normalizes to an existing slug is a duplicate
  expect(() => createSite(db, { name: "my  blog" })).toThrow();
  // an unusable name is rejected outright
  expect(() => createSite(db, { name: "  " })).toThrow();
});

test("normalizeSitePath canonicalizes and resolves within the bucket", () => {
  expect(normalizeSitePath("/index.html")).toBe("index.html");
  expect(normalizeSitePath("css//app.css")).toBe("css/app.css");
  expect(normalizeSitePath("./a/./b.js")).toBe("a/b.js");
  expect(normalizeSitePath("a/../b.txt")).toBe("b.txt");
  expect(normalizeSitePath("")).toBe("");
  expect(normalizeSitePath("/")).toBe("");
});

test("putFile normalizes the path so noisy variants hit one stored file", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  const f = await putFile(db, s.id, "/css//app.css", { data: "a{}" });
  expect(f.path).toBe("css/app.css");
  // re-upload via a different-but-equivalent path merges into the same row
  const again = await putFile(db, s.id, "css/app.css", { data: "b{}" });
  expect(again.id).toBe(f.id);
  expect(listFiles(db, s.id).length).toBe(1);
  // served + deleted via equivalent noisy paths
  expect(dec((await getFileForServe(db, s.id, "/css/app.css"))!.bytes)).toBe("b{}");
  expect(deleteFile(db, s.id, "css//app.css")).toBe(true);
  expect(listFiles(db, s.id).length).toBe(0);
  // a path that normalizes to nothing is rejected
  await expect(putFile(db, s.id, "/", { data: "x" })).rejects.toThrow();
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

test("small non-image binaries store inline as base64 and round-trip", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  const bin = new Uint8Array([0x00, 0x01, 0x02, 0xfe, 0xff, 3, 4, 5]);
  const f = await putFile(db, s.id, "data/payload.bin", { data: bin });
  expect(f.encoding).toBe("base64");
  expect(f.content_type).toBe("application/octet-stream");

  const served = await getFileForServe(db, s.id, "data/payload.bin");
  expect(Array.from(served!.bytes)).toEqual(Array.from(bin));
});

test("images always store as a blob (never inline base64) and round-trip", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const f = await putFile(db, s.id, "img/logo.png", { data: png });
  expect(f.encoding).toBe("blob");
  expect(f.content_type).toBe("image/png");
  expect(f.content).toHaveLength(32); // canonical 32-hex content hash

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

test("putFileInline stores utf8 text + small base64, throws on oversized binary", () => {
  const db = makeNode("nodeIN01");
  const site = createSite(db, { name: "inline" });
  // utf8 text rides the oplog as readable content.
  const html = putFileInline(db, site.id, "index.html", { data: "<h1>hi</h1>" });
  expect(html.encoding).toBe("utf8");
  expect(html.content).toBe("<h1>hi</h1>");
  // small binary → base64 inline.
  const png = putFileInline(db, site.id, "a.png", { data: new Uint8Array([1, 2, 3]) });
  expect(png.encoding).toBe("base64");
  expect(fileCount(db, site.id)).toBe(2);
  // oversized binary needs the server blob store — portable path refuses it.
  const big = new Uint8Array(256 * 1024 + 1);
  expect(() => putFileInline(db, site.id, "big.bin", { data: big })).toThrow();
});
