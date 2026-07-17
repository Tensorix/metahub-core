import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSchema } from "../db.ts";
import { ingest, changesSince } from "../crdt.ts";
import { createSite, updateSite, putFile, writeFileRow, getFileMetaForServe } from "../sites.ts";
import { serveSite } from "./sites-serve.ts";
import type { AuthConfig } from "./auth.ts";

function makeCtx(node = "hostnode") {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(node);
  return { db, node } as { db: Database; node: string };
}

// Auth off (--debug / desktop sidecar): hasValidToken is always true, so
// private sites serve normally — the pre-Batch-4 behavior.
const AUTH_OFF: AuthConfig = { debug: true, staticToken: null, db: null, ttlMs: 0, graceMs: 0 };
// A real token gate (static-token mode) for the visibility tests.
const TOKEN = "test-token-1234";
const AUTH_TOKEN: AuthConfig = { debug: false, staticToken: TOKEN, db: null, ttlMs: 0, graceMs: 0 };

const req = (path: string, headers: Record<string, string> = {}) =>
  new Request("http://x" + path, { headers });
const asBrowser = (path: string, extra: Record<string, string> = {}) =>
  req(path, { accept: "text/html,application/xhtml+xml", ...extra });
const withToken = (path: string, extra: Record<string, string> = {}) =>
  req(path, { authorization: `Bearer ${TOKEN}`, ...extra });

// Isolate blob reads/writes (cache.ts → METAHUB_HOME/cache) into a throwaway
// dir so tests never touch the real ~/.metahub.
const ORIGINAL_HOME = process.env.METAHUB_HOME;
let TMP_HOME: string;
beforeAll(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), "mh-sites-serve-"));
  process.env.METAHUB_HOME = TMP_HOME;
});
afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.METAHUB_HOME;
  else process.env.METAHUB_HOME = ORIGINAL_HOME;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test("served files carry a weak ETag and tiered Cache-Control (html / inline asset / blob)", async () => {
  const ctx = makeCtx();
  const s = createSite(ctx.db, { name: "demo" });
  await putFile(ctx.db, s.id, "index.html", { data: "<h1>hi</h1>" });
  await putFile(ctx.db, s.id, "app.css", { data: "a{}" });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  await putFile(ctx.db, s.id, "logo.png", { data: png }); // images always store as blob

  const html = (await serveSite(req("/sites/demo/"), ctx, AUTH_OFF))!;
  expect(html.status).toBe(200);
  expect(html.headers.get("etag")).toMatch(/^W\/"[0-9a-f]+"$/);
  expect(html.headers.get("cache-control")).toBe("private, no-cache");

  const css = (await serveSite(req("/sites/demo/app.css"), ctx, AUTH_OFF))!;
  expect(css.status).toBe(200);
  expect(css.headers.get("cache-control")).toBe("private, max-age=300, stale-while-revalidate=3600");

  const blob = (await serveSite(req("/sites/demo/logo.png"), ctx, AUTH_OFF))!;
  expect(blob.status).toBe(200);
  expect(blob.headers.get("cache-control")).toBe("private, max-age=3600");
  // a blob row's ETag is its content hash, verbatim
  const meta = getFileMetaForServe(ctx.db, s.id, "logo.png")!;
  expect(blob.headers.get("etag")).toBe(`W/"${meta.row.content}"`);
});

test("If-None-Match hit answers 304 with no body; content change re-serves 200", async () => {
  const ctx = makeCtx();
  const s = createSite(ctx.db, { name: "demo" });
  await putFile(ctx.db, s.id, "index.html", { data: "<h1>v1</h1>" });

  const first = (await serveSite(req("/sites/demo/"), ctx, AUTH_OFF))!;
  const etag = first.headers.get("etag")!;

  const revalidated = (await serveSite(req("/sites/demo/", { "if-none-match": etag }), ctx, AUTH_OFF))!;
  expect(revalidated.status).toBe(304);
  expect(await revalidated.text()).toBe("");
  expect(revalidated.headers.get("etag")).toBe(etag);
  expect(revalidated.headers.get("cache-control")).toBe("private, no-cache");

  // multi-value header lists match too (weak comparison)
  const multi = (await serveSite(
    req("/sites/demo/", { "if-none-match": `"other", ${etag}` }),
    ctx,
    AUTH_OFF,
  ))!;
  expect(multi.status).toBe(304);

  // republish → new etag → the stale validator re-serves 200 with fresh bytes
  await putFile(ctx.db, s.id, "index.html", { data: "<h1>v2</h1>" });
  const changed = (await serveSite(req("/sites/demo/", { "if-none-match": etag }), ctx, AUTH_OFF))!;
  expect(changed.status).toBe(200);
  expect(changed.headers.get("etag")).not.toBe(etag);
  expect(await changed.text()).toContain("<h1>v2</h1>");
});

test("blob row: If-None-Match hit 304s before resolveBlob (unresolvable hash still 304s)", async () => {
  const ctx = makeCtx();
  const s = createSite(ctx.db, { name: "demo" });
  // A blob row whose bytes exist nowhere: if the 304 path ever decoded first,
  // this request could not succeed.
  const fakeHash = "0123456789abcdef0123456789abcdef";
  writeFileRow(ctx.db, s.id, "img/ghost.png", "image/png", "blob", fakeHash);

  const hit = (await serveSite(
    req("/sites/demo/img/ghost.png", { "if-none-match": `W/"${fakeHash}"` }),
    ctx,
    AUTH_OFF,
  ))!;
  expect(hit.status).toBe(304);
  expect(await hit.text()).toBe("");

  // validator miss → must decode → bytes unreachable → 404
  const miss = (await serveSite(req("/sites/demo/img/ghost.png"), ctx, AUTH_OFF))!;
  expect(miss.status).toBe(404);
});

test("a site's own 404.html serves misses with status 404", async () => {
  const ctx = makeCtx();
  const s = createSite(ctx.db, { name: "demo" });
  await putFile(ctx.db, s.id, "404.html", { data: "<h1>custom missing</h1>" });

  const res = (await serveSite(req("/sites/demo/nope.html"), ctx, AUTH_OFF))!;
  expect(res.status).toBe(404);
  expect(await res.text()).toContain("custom missing");
  expect(res.headers.get("content-type")).toContain("text/html");
  // the fallback page is HTML → negotiated like any other page (etag present)
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
});

test("built-in 404 page: pure miss and unknown site are no-store HTML", async () => {
  const ctx = makeCtx();
  createSite(ctx.db, { name: "demo" });

  const miss = (await serveSite(req("/sites/demo/nope.html"), ctx, AUTH_OFF))!;
  expect(miss.status).toBe(404);
  expect(miss.headers.get("content-type")).toContain("text/html");
  expect(miss.headers.get("cache-control")).toBe("no-store");
  expect(await miss.text()).toContain("404");

  const noSite = (await serveSite(req("/sites/ghost/"), ctx, AUTH_OFF))!;
  expect(noSite.status).toBe(404);
  expect(noSite.headers.get("cache-control")).toBe("no-store");
  expect(await noSite.text()).toContain("站点不存在");
});

test("/sites/<name> still 301s to the canonical trailing-slash URL", async () => {
  const ctx = makeCtx();
  createSite(ctx.db, { name: "demo" });
  const res = (await serveSite(req("/sites/demo"), ctx, AUTH_OFF))!;
  expect(res.status).toBe(301);
  expect(res.headers.get("location")).toBe("http://x/sites/demo/");
});

// ---- Batch 4: visibility (public access), anti-enumeration, injection --------

test("public site serves without a token, with `public, …` headers and NO runtime", async () => {
  const ctx = makeCtx();
  const s = createSite(ctx.db, { name: "demo", visibility: "public" });
  await putFile(ctx.db, s.id, "index.html", { data: "<html><head></head><body>hi</body></html>" });
  await putFile(ctx.db, s.id, "app.css", { data: "a{}" });

  const html = (await serveSite(req("/sites/demo/"), ctx, AUTH_TOKEN))!;
  expect(html.status).toBe(200);
  expect(html.headers.get("cache-control")).toBe("public, no-cache");
  expect(await html.text()).not.toContain("mh-runtime"); // red line: no runtime to anonymous readers

  const css = (await serveSite(req("/sites/demo/app.css"), ctx, AUTH_TOKEN))!;
  expect(css.status).toBe(200);
  expect(css.headers.get("cache-control")).toBe("public, max-age=300, stale-while-revalidate=3600");
});

test("private site without a token: unlock page for browsers, 401 otherwise", async () => {
  const ctx = makeCtx();
  const s = createSite(ctx.db, { name: "demo" });
  await putFile(ctx.db, s.id, "index.html", { data: "<h1>secret</h1>" });

  const nav = (await serveSite(asBrowser("/sites/demo/"), ctx, AUTH_TOKEN))!;
  expect(nav.status).toBe(200);
  expect(nav.headers.get("x-mh-unlock")).toBe("1"); // SW must not cache this as the shell
  const body = await nav.text();
  expect(body).toContain("访问令牌");
  expect(body).not.toContain("secret");

  const api = (await serveSite(req("/sites/demo/app.js"), ctx, AUTH_TOKEN))!;
  expect(api.status).toBe(401);
});

test("anti-enumeration: private and nonexistent sites answer identically without a token", async () => {
  const ctx = makeCtx();
  const s = createSite(ctx.db, { name: "real" });
  await putFile(ctx.db, s.id, "index.html", { data: "<h1>secret</h1>" });

  // HTML navigation: byte-identical unlock pages.
  const priv = (await serveSite(asBrowser("/sites/real/"), ctx, AUTH_TOKEN))!;
  const ghost = (await serveSite(asBrowser("/sites/ghost/"), ctx, AUTH_TOKEN))!;
  expect(ghost.status).toBe(priv.status);
  expect([...ghost.headers.entries()]).toEqual([...priv.headers.entries()]);
  expect(await ghost.text()).toBe(await priv.text());

  // Non-HTML: byte-identical 401s.
  const privJs = (await serveSite(req("/sites/real/app.js"), ctx, AUTH_TOKEN))!;
  const ghostJs = (await serveSite(req("/sites/ghost/app.js"), ctx, AUTH_TOKEN))!;
  expect(ghostJs.status).toBe(privJs.status);
  expect(await ghostJs.text()).toBe(await privJs.text());
});

test("default-deny: junk visibility register values stay private", async () => {
  const ctx = makeCtx();
  for (const [name, junk] of [
    ["a", "PUBLIC"],
    ["b", "true"],
    ["c", "yes-definitely-public"],
  ] as const) {
    const s = createSite(ctx.db, { name });
    await putFile(ctx.db, s.id, "index.html", { data: "<h1>x</h1>" });
    // A peer can sync ANY string into the register — write it raw, bypassing
    // updateSite's local enum validation.
    ctx.db.query("UPDATE sites SET visibility = ? WHERE id = ?").run(junk, s.id);
    const res = (await serveSite(req(`/sites/${name}/`), ctx, AUTH_TOKEN))!;
    expect(res.status).toBe(401); // still gated
  }
});

test("with the token a private site serves normally and HTML gets the runtime", async () => {
  const ctx = makeCtx();
  const s = createSite(ctx.db, { name: "demo" });
  await putFile(ctx.db, s.id, "index.html", { data: "<html><head></head><body>hi</body></html>" });

  const html = (await serveSite(withToken("/sites/demo/"), ctx, AUTH_TOKEN))!;
  expect(html.status).toBe(200);
  expect(html.headers.get("cache-control")).toBe("private, no-cache");
  expect(await html.text()).toContain("mh-runtime.js");

  // authenticated miss on an unknown site is an honest 404 (not the unlock page)
  const ghost = (await serveSite(withToken("/sites/ghost/"), ctx, AUTH_TOKEN))!;
  expect(ghost.status).toBe(404);
  expect(await ghost.text()).toContain("站点不存在");
});

test("SPA mode: extension-less miss serves index.html 200; assets still 404", async () => {
  const ctx = makeCtx();
  const s = createSite(ctx.db, { name: "app", visibility: "public" });
  await putFile(ctx.db, s.id, "index.html", { data: "<html><head></head><body>shell</body></html>" });
  updateSite(ctx.db, s.id, { spa: true });

  const route = (await serveSite(req("/sites/app/settings/profile"), ctx, AUTH_TOKEN))!;
  expect(route.status).toBe(200);
  expect(await route.text()).toContain("shell");

  const asset = (await serveSite(req("/sites/app/missing.js"), ctx, AUTH_TOKEN))!;
  expect(asset.status).toBe(404);
});

// ---- Batch 4: two-node sync smoke -------------------------------------------

test("two-node smoke: visibility=public set on A replicates to B and serves token-free", async () => {
  const a = makeCtx("nodeaaaa");
  const b = makeCtx("nodebbbb");

  const s = createSite(a.db, { name: "demo" });
  await putFile(a.db, s.id, "index.html", { data: "<html><head></head><body>pub</body></html>" });
  updateSite(a.db, s.id, { visibility: "public", spa: true });

  ingest(b.db, changesSince(a.db, ""));

  // B (a different server with its own token) now serves the site publicly...
  const res = (await serveSite(req("/sites/demo/"), b, AUTH_TOKEN))!;
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("pub");
  expect(body).not.toContain("mh-runtime");
  // ...including the replicated SPA flag.
  const route = (await serveSite(req("/sites/demo/deep/route"), b, AUTH_TOKEN))!;
  expect(route.status).toBe(200);

  // Flipping back to private on A closes B after the next sync.
  updateSite(a.db, s.id, { visibility: "private" });
  ingest(b.db, changesSince(a.db, ""));
  const closed = (await serveSite(req("/sites/demo/"), b, AUTH_TOKEN))!;
  expect(closed.status).toBe(401);
});

test("two-node smoke: a malicious sites change (unknown column) doesn't break ingest", async () => {
  const a = makeCtx("nodeaaaa");
  const b = makeCtx("nodebbbb");
  const s = createSite(a.db, { name: "demo" });
  await putFile(a.db, s.id, "index.html", { data: "<h1>x</h1>" });
  updateSite(a.db, s.id, { visibility: "public" });

  const changes = changesSince(a.db, "");
  const malicious = {
    hlc: "9999999999999-0000-evilnode",
    node_id: "evilnode",
    dataset: "sites",
    row_id: s.id,
    col: "grant_all_the_things", // unknown column → skipped (forward-compat)
    value: JSON.stringify("muahaha"),
    txn: null,
  };
  // Interleave: the batch must survive the unknown column mid-stream.
  ingest(b.db, [changes[0]!, malicious, ...changes.slice(1)]);

  const res = (await serveSite(req("/sites/demo/"), b, AUTH_TOKEN))!;
  expect(res.status).toBe(200); // real changes all landed
  const cols = (b.db.query("PRAGMA table_info(sites)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).not.toContain("grant_all_the_things");
});
