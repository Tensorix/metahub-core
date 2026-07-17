import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runSchema } from "./db.ts";
import { ingest, changesSince } from "./crdt.ts";
import {
  createSite,
  isSitePublic,
  getSite,
  getSiteByName,
  listSites,
  updateSite,
  deleteSite,
  resolveSite,
  putFile,
  putFileInline,
  publishDirectory,
  fileCount,
  fileCounts,
  fileSizeOf,
  listFiles,
  deleteFile,
  getFileForServe,
  resolveSiteFileRow,
  inferContentType,
  normalizeSiteName,
  normalizeSitePath,
  bytesToBase64,
  base64ToBytes,
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

test("resolveSiteFileRow: direct hit and index.html resolution carry status 200", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  await putFile(db, s.id, "index.html", { data: "<h1>root</h1>" });
  await putFile(db, s.id, "sub/index.html", { data: "<h1>sub</h1>" });
  await putFile(db, s.id, "app.css", { data: "a{}" });

  const direct = resolveSiteFileRow(db, s.id, "app.css")!;
  expect(direct.status).toBe(200);
  expect(direct.row.content).toBe("a{}");
  // "" and trailing "/" resolve to index.html, same as getFileRow
  expect(resolveSiteFileRow(db, s.id, "")!.row.content).toBe("<h1>root</h1>");
  expect(resolveSiteFileRow(db, s.id, "sub/")!.row.content).toBe("<h1>sub</h1>");
});

test("resolveSiteFileRow: miss falls back to the site's 404.html with status 404", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  await putFile(db, s.id, "404.html", { data: "<h1>custom missing</h1>" });

  const hit = resolveSiteFileRow(db, s.id, "nope.html")!;
  expect(hit.status).toBe(404);
  expect(hit.row.content).toBe("<h1>custom missing</h1>");
  // an existing file still serves normally with the fallback present
  await putFile(db, s.id, "index.html", { data: "<h1>hi</h1>" });
  expect(resolveSiteFileRow(db, s.id, "")!.status).toBe(200);
});

test("resolveSiteFileRow: pure miss (no 404.html) is null", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  await putFile(db, s.id, "index.html", { data: "<h1>hi</h1>" });
  expect(resolveSiteFileRow(db, s.id, "nope.html")).toBeNull();
  // a path that normalizes to nothing is a miss too
  expect(resolveSiteFileRow(db, s.id, "..")).toBeNull();
});

test("fileCounts aggregates live files per site in one query", async () => {
  const db = makeNode("n1");
  const a = createSite(db, { name: "a" });
  const b = createSite(db, { name: "b" });
  const empty = createSite(db, { name: "empty" });
  await putFile(db, a.id, "index.html", { data: "<p>1</p>" });
  await putFile(db, a.id, "app.css", { data: "a{}" });
  await putFile(db, b.id, "index.html", { data: "<p>2</p>" });
  deleteFile(db, b.id, "index.html"); // tombstoned rows don't count

  const counts = fileCounts(db);
  expect(counts.get(a.id)).toBe(2);
  expect(counts.get(b.id)).toBeUndefined(); // callers default missing → 0
  expect(counts.get(empty.id)).toBeUndefined();
  // agrees with the per-site count
  expect(counts.get(a.id)).toBe(fileCount(db, a.id));
});

test("bytesToBase64 / base64ToBytes round-trip arbitrary bytes", () => {
  const bytes = new Uint8Array([0, 1, 2, 0x7f, 0x80, 0xfe, 0xff, 42]);
  const b64 = bytesToBase64(bytes);
  expect(btoa(String.fromCharCode(...bytes))).toBe(b64);
  expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
  // empty input round-trips too
  expect(Array.from(base64ToBytes(bytesToBase64(new Uint8Array(0))))).toEqual([]);
});

// ---- skip-unchanged ---------------------------------------------------------

test("re-uploading identical content is a no-op: changed:false, zero oplog delta", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  const first = await putFile(db, s.id, "index.html", { data: "<h1>hi</h1>" });
  expect(first.changed).toBe(true);

  const before = changesSince(db, "").length;
  const again = await putFile(db, s.id, "index.html", { data: "<h1>hi</h1>" });
  expect(again.changed).toBe(false);
  expect(again.id).toBe(first.id);
  expect(changesSince(db, "").length).toBe(before); // not a single new oplog row

  // changed content still writes
  const edited = await putFile(db, s.id, "index.html", { data: "<h1>v2</h1>" });
  expect(edited.changed).toBe(true);
  expect(changesSince(db, "").length).toBeGreaterThan(before);
  expect(dec((await getFileForServe(db, s.id, "index.html"))!.bytes)).toBe("<h1>v2</h1>");

  // same content under a different content type is a change (triple compare)
  const retyped = await putFile(db, s.id, "index.html", {
    data: "<h1>v2</h1>",
    contentType: "text/plain",
  });
  expect(retyped.changed).toBe(true);
});

test("re-uploading the same bytes to a deleted file un-deletes (changed:true)", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  await putFile(db, s.id, "x.txt", { data: "same" });
  expect(deleteFile(db, s.id, "x.txt")).toBe(true);

  const back = await putFile(db, s.id, "x.txt", { data: "same" });
  expect(back.changed).toBe(true);
  expect(dec((await getFileForServe(db, s.id, "x.txt"))!.bytes)).toBe("same");
});

test("blob files skip unchanged re-uploads by content hash", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const first = await putFile(db, s.id, "img/logo.png", { data: png });
  expect(first.changed).toBe(true);
  expect(first.encoding).toBe("blob");

  const before = changesSince(db, "").length;
  const again = await putFile(db, s.id, "img/logo.png", { data: png });
  expect(again.changed).toBe(false);
  expect(changesSince(db, "").length).toBe(before);

  // different bytes → different hash → real write
  const png2 = new Uint8Array([...png, 9]);
  expect((await putFile(db, s.id, "img/logo.png", { data: png2 })).changed).toBe(true);
});

// ---- publishDirectory -------------------------------------------------------

function makeTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mh-publish-"));
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  return dir;
}

test("publishDirectory: full upload, idempotent re-run, prune mirrors local deletes", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  const dir = makeTree({
    "index.html": "<h1>hi</h1>",
    "css/app.css": "a{}",
    "js/app.js": "x()",
  });
  try {
    const first = await publishDirectory(db, s.id, dir);
    expect(first.uploaded).toEqual(["css/app.css", "index.html", "js/app.js"]); // path-sorted
    expect(first.unchanged).toEqual([]);
    expect(first.pruned).toEqual([]);

    const before = changesSince(db, "").length;
    const rerun = await publishDirectory(db, s.id, dir);
    expect(rerun.uploaded).toEqual([]);
    expect(rerun.unchanged).toEqual(["css/app.css", "index.html", "js/app.js"]);
    expect(changesSince(db, "").length).toBe(before); // idempotent: zero oplog delta

    // delete one local file: without prune the remote copy stays…
    rmSync(join(dir, "js/app.js"));
    const noPrune = await publishDirectory(db, s.id, dir);
    expect(noPrune.pruned).toEqual([]);
    expect(listFiles(db, s.id).map((f) => f.path)).toContain("js/app.js");

    // …with prune it mirrors the delete, and reports it as evidence
    const mirrored = await publishDirectory(db, s.id, dir, { prune: true });
    expect(mirrored.unchanged).toEqual(["css/app.css", "index.html"]);
    expect(mirrored.pruned).toEqual(["js/app.js"]);
    expect(listFiles(db, s.id).map((f) => f.path)).toEqual(["css/app.css", "index.html"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publishDirectory: empty directory throws", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  const dir = mkdtempSync(join(tmpdir(), "mh-publish-empty-"));
  try {
    await expect(publishDirectory(db, s.id, dir)).rejects.toThrow("no files found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publishDirectory: concurrent workers land every file with correct content", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  const files: Record<string, string> = {};
  for (let i = 0; i < 20; i++) files[`p${String(i).padStart(2, "0")}/f${i}.txt`] = `content-${i}`;
  const dir = makeTree(files);
  try {
    const res = await publishDirectory(db, s.id, dir); // default pool of 8
    expect(res.uploaded.length).toBe(20);
    expect(res.uploaded).toEqual([...res.uploaded].sort());
    expect(fileCounts(db).get(s.id)).toBe(20);
    for (const [p, content] of Object.entries(files)) {
      expect(dec((await getFileForServe(db, s.id, p))!.bytes)).toBe(content);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// ---- listFiles derived size ---------------------------------------------------

test("listFiles size: utf8 exact bytes, base64 approximated, blob via blob_cache", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });

  // utf8: exact BYTE length (multibyte chars count their encoded bytes)
  await putFile(db, s.id, "index.html", { data: "<h1>你好</h1>" });
  // base64: 6 raw bytes encode to 8 chars with no padding → (8/4)*3 = 6 exact;
  // padded lengths overshoot by ≤2 (display-grade approximation)
  await putFile(db, s.id, "data/six.bin", { data: new Uint8Array(6) });
  await putFile(db, s.id, "data/eight.bin", { data: new Uint8Array(8) });
  // blob: content is the hash; blob_cache carries the true size
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  await putFile(db, s.id, "img/logo.png", { data: png });

  const byPath = new Map(listFiles(db, s.id).map((f) => [f.path, f]));
  expect(byPath.get("index.html")!.size).toBe(new TextEncoder().encode("<h1>你好</h1>").byteLength);
  expect(byPath.get("data/six.bin")!.size).toBe(6);
  expect(byPath.get("data/eight.bin")!.size).toBe(9); // 12 b64 chars → 9 (padding ignored)
  expect(byPath.get("img/logo.png")!.size).toBe(png.byteLength);

  // fileSizeOf (single-row derivation the upload route uses) agrees with the SQL
  for (const f of listFiles(db, s.id)) {
    const row = db
      .query("SELECT encoding, content FROM site_files WHERE id = ?")
      .get(f.id) as { encoding: "utf8" | "base64" | "blob"; content: string | null };
    expect(fileSizeOf(db, row)).toBe(f.size);
  }

  // blob bytes not held locally (evicted cache / browser replica) → null
  db.query("DELETE FROM blob_cache").run();
  expect(listFiles(db, s.id).find((f) => f.path === "img/logo.png")!.size).toBeNull();
});

// ---- Batch 4: visibility / spa ------------------------------------------------

test("visibility: default private, set via create/updateSite, junk values rejected", () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  expect(s.visibility).toBeNull(); // default: private
  expect(isSitePublic(s)).toBe(false);

  const pub = updateSite(db, s.id, { visibility: "public" });
  expect(pub.visibility).toBe("public");
  expect(isSitePublic(pub)).toBe(true);
  const priv = updateSite(db, s.id, { visibility: "private" });
  expect(isSitePublic(priv)).toBe(false);

  // local writes only accept the two canonical values
  expect(() => updateSite(db, s.id, { visibility: "PUBLIC" as "public" })).toThrow("visibility must be");
  expect(() => updateSite(db, s.id, { visibility: "yes" as "public" })).toThrow("visibility must be");
  expect(() => createSite(db, { name: "x", visibility: "sure" as "public" })).toThrow("visibility must be");

  // created --public
  const born = createSite(db, { name: "open", visibility: "public" });
  expect(isSitePublic(born)).toBe(true);
});

test("isSitePublic is default-deny against synced junk register values", () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  for (const junk of ["PUBLIC", "true", "1", "", "public ", null]) {
    db.query("UPDATE sites SET visibility = ? WHERE id = ?").run(junk, s.id);
    expect(isSitePublic(getSite(db, s.id)!)).toBe(false);
  }
  db.query("UPDATE sites SET visibility = 'public' WHERE id = ?").run(s.id);
  expect(isSitePublic(getSite(db, s.id)!)).toBe(true);
});

test("updateSite toggles spa and it round-trips through the row", () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "demo" });
  expect(s.spa).toBe(0);
  expect(updateSite(db, s.id, { spa: true }).spa).toBe(1);
  expect(updateSite(db, s.id, { spa: false }).spa).toBe(0);
});

test("resolveSiteFileRow spa×extension quadrants", async () => {
  const db = makeNode("n1");
  const s = createSite(db, { name: "app" });
  await putFile(db, s.id, "index.html", { data: "<h1>shell</h1>" });

  // spa on + extension-less miss → index.html, status 200
  const route = resolveSiteFileRow(db, s.id, "settings/profile", { spa: true })!;
  expect(route.status).toBe(200);
  expect(route.row.content).toBe("<h1>shell</h1>");
  // directory-style miss counts as extension-less too
  expect(resolveSiteFileRow(db, s.id, "settings/", { spa: true })!.status).toBe(200);

  // spa on + extensioned miss → honest miss (null here: no 404.html)
  expect(resolveSiteFileRow(db, s.id, "missing.js", { spa: true })).toBeNull();

  // spa off → both miss
  expect(resolveSiteFileRow(db, s.id, "settings/profile")).toBeNull();
  expect(resolveSiteFileRow(db, s.id, "missing.js", { spa: false })).toBeNull();

  // real files still win over the fallback under spa
  await putFile(db, s.id, "about.html", { data: "<h1>about</h1>" });
  expect(resolveSiteFileRow(db, s.id, "about.html", { spa: true })!.row.content).toBe("<h1>about</h1>");

  // with a 404.html present, an extensioned miss falls back to it (404), while
  // an extension-less miss still prefers the SPA shell (200)
  await putFile(db, s.id, "404.html", { data: "<h1>nope</h1>" });
  expect(resolveSiteFileRow(db, s.id, "missing.js", { spa: true })!.status).toBe(404);
  expect(resolveSiteFileRow(db, s.id, "deep/route", { spa: true })!.status).toBe(200);
});

test("visibility and spa replicate to another node via the oplog", () => {
  const a = makeNode("a");
  const b = makeNode("b");
  const s = createSite(a, { name: "demo" });
  updateSite(a, s.id, { visibility: "public", spa: true });

  ingest(b, changesSince(a, ""));
  const remote = getSite(b, s.id)!;
  expect(remote.visibility).toBe("public");
  expect(remote.spa).toBe(1);
  expect(isSitePublic(remote)).toBe(true);
});
