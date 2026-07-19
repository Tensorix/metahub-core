import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { ingest, changesSince } from "../crdt.ts";
import { createDatabase } from "../databases.ts";
import { addProperty, listProperties } from "../properties.ts";
import { createRecord, listRecords } from "../records.ts";
import { createSite, putFile, setSitePublicGrants } from "../sites.ts";
import { serveSite } from "./sites-serve.ts";
import { FixedWindowLimiter, PUBLIC_WRITE_LIMIT, PUBLIC_READ_LIMIT } from "./rate-limit.ts";
import type { AuthConfig } from "./auth.ts";
import type { GrantSet } from "../grants-core.ts";

// Endpoint-level tests of the granted API through its real /sites/<name>/api/*
// mount (serveSite → serveGrantedApi), token gate and all.

function makeCtx(node = "hostnode") {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(node);
  return { db, node } as { db: Database; node: string };
}

const TOKEN = "test-token-1234";
const AUTH_TOKEN: AuthConfig = { debug: false, staticToken: TOKEN, db: null, ttlMs: 0, graceMs: 0 };

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request("http://x" + path, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://x" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const patch = (path: string, body: unknown) =>
  new Request("http://x" + path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** A public site + a guestbook db; returns the pieces tests mix and match. */
function seed(ctx: { db: Database; node: string }, opts: { grants?: GrantSet | null; visibility?: "public" | "private" } = {}) {
  const d = createDatabase(ctx.db, { name: "Guestbook" });
  addProperty(ctx.db, d.id, { name: "Msg", type: "text" });
  const rec = createRecord(ctx.db, d.id, { Msg: "seed row" });
  const site = createSite(ctx.db, { name: "demo", visibility: opts.visibility ?? "public" });
  if (opts.grants !== undefined && opts.grants !== null)
    setSitePublicGrants(ctx.db, site.id, opts.grants);
  return { d, rec, site };
}

test("public site with NO grants: every api call is 401", async () => {
  const ctx = makeCtx();
  const { d, rec } = seed(ctx);
  for (const req of [
    get(`/sites/demo/api/records?db=${d.id}`),
    get(`/sites/demo/api/record?id=${rec.id}`),
    get(`/sites/demo/api/properties?db=${d.id}`),
    post(`/sites/demo/api/records?db=${d.id}`, { Msg: "spam" }),
    patch(`/sites/demo/api/record?id=${rec.id}`, { Msg: "spam" }),
  ]) {
    const res = (await serveSite(req, ctx, AUTH_TOKEN))!;
    expect(res.status).toBe(401);
  }
});

test("read grant: GETs 200 with main-API shapes; writes stay 401", async () => {
  const ctx = makeCtx();
  const d0 = createDatabase(ctx.db, { name: "Guestbook" });
  addProperty(ctx.db, d0.id, { name: "Msg", type: "text" });
  const rec = createRecord(ctx.db, d0.id, { Msg: "seed row" });
  const site = createSite(ctx.db, { name: "demo", visibility: "public" });
  setSitePublicGrants(ctx.db, site.id, { v: 1, tables: [{ db: d0.id, ops: ["read"] }] });

  // by db NAME too (resolution stays within the granted set)
  const list = (await serveSite(get(`/sites/demo/api/records?db=guestbook`), ctx, AUTH_TOKEN))!;
  expect(list.status).toBe(200);
  const rows = (await list.json()) as Record<string, unknown>[];
  // shape parity with the main API (listRecords → {id, database_id, values, cells})
  const direct = listRecords(ctx.db, d0.id);
  expect(rows).toEqual(JSON.parse(JSON.stringify(direct)));
  expect(Object.keys(rows[0]!).sort()).toEqual(["cells", "database_id", "id", "values"]);

  const one = (await serveSite(get(`/sites/demo/api/record?id=${rec.id}`), ctx, AUTH_TOKEN))!;
  expect(one.status).toBe(200);
  expect(((await one.json()) as { values: { Msg: string } }).values.Msg).toBe("seed row");

  const props = (await serveSite(get(`/sites/demo/api/properties?db=${d0.id}`), ctx, AUTH_TOKEN))!;
  expect(props.status).toBe(200);
  expect(await props.json()).toEqual(JSON.parse(JSON.stringify(listProperties(ctx.db, d0.id))));

  // read grant does NOT open writes
  const write = (await serveSite(post(`/sites/demo/api/records?db=${d0.id}`, { Msg: "x" }), ctx, AUTH_TOKEN))!;
  expect(write.status).toBe(401);
  const upd = (await serveSite(patch(`/sites/demo/api/record?id=${rec.id}`, { Msg: "x" }), ctx, AUTH_TOKEN))!;
  expect(upd.status).toBe(401);
});

test("create-only grant: POST lands attributed to the derived public guest; GET/PATCH 401", async () => {
  const ctx = makeCtx();
  const d = createDatabase(ctx.db, { name: "Guestbook" });
  addProperty(ctx.db, d.id, { name: "Msg", type: "text" });
  const rec = createRecord(ctx.db, d.id, { Msg: "seed" });
  const site = createSite(ctx.db, { name: "demo", visibility: "public" });
  setSitePublicGrants(ctx.db, site.id, { v: 1, tables: [{ db: d.id, ops: ["create"] }] });

  const res = (await serveSite(post(`/sites/demo/api/records?db=${d.id}`, { Msg: "from guest" }), ctx, AUTH_TOKEN))!;
  expect(res.status).toBe(200);
  const created = (await res.json()) as { id: string; values: { Msg: string } };
  expect(created.values.Msg).toBe("from guest");

  // attribution: gp-<site8>-<node8>, derived, never the host node
  const node = ctx.db
    .query("SELECT DISTINCT node_id FROM crdt_changes WHERE dataset='records' AND row_id=?")
    .all(created.id) as { node_id: string }[];
  expect(node).toEqual([{ node_id: `gp-${site.id.slice(-8)}-${ctx.node.slice(0, 8)}` }]);

  const read = (await serveSite(get(`/sites/demo/api/records?db=${d.id}`), ctx, AUTH_TOKEN))!;
  expect(read.status).toBe(401);
  const upd = (await serveSite(patch(`/sites/demo/api/record?id=${rec.id}`, { Msg: "x" }), ctx, AUTH_TOKEN))!;
  expect(upd.status).toBe(401);
});

test("PRIVATE site with grants: the whole api surface answers 401 (grants arm only when public)", async () => {
  const ctx = makeCtx();
  const d = createDatabase(ctx.db, { name: "Guestbook" });
  addProperty(ctx.db, d.id, { name: "Msg", type: "text" });
  const site = createSite(ctx.db, { name: "demo" }); // private
  setSitePublicGrants(ctx.db, site.id, { v: 1, tables: [{ db: d.id, ops: ["read", "create"] }] });

  const read = (await serveSite(get(`/sites/demo/api/records?db=${d.id}`), ctx, AUTH_TOKEN))!;
  expect(read.status).toBe(401);
  const write = (await serveSite(post(`/sites/demo/api/records?db=${d.id}`, { Msg: "x" }), ctx, AUTH_TOKEN))!;
  expect(write.status).toBe(401);
  // …and indistinguishable from a nonexistent site
  const ghost = (await serveSite(get(`/sites/ghost/api/records?db=${d.id}`), ctx, AUTH_TOKEN))!;
  expect(ghost.status).toBe(401);
  expect(await ghost.text()).toBe(await (await serveSite(get(`/sites/demo/api/records?db=${d.id}`), ctx, AUTH_TOKEN))!.text());
});

test("token holder under /sites/<name>/api/* gets the FULL api via in-process forward", async () => {
  const ctx = makeCtx();
  const d = createDatabase(ctx.db, { name: "Anything" });
  createSite(ctx.db, { name: "demo" }); // private, no grants
  // a fake main-API route table: proves the rewrite hits /api/* verbatim
  const forwardApi = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/api/databases")
      return Response.json([{ id: d.id, forwarded: true, q: url.searchParams.get("x") }]);
    return new Response("not found", { status: 404 });
  };
  const res = (await serveSite(
    get(`/sites/demo/api/databases?x=1`, { authorization: `Bearer ${TOKEN}` }),
    ctx,
    AUTH_TOKEN,
    { forwardApi },
  ))!;
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([{ id: d.id, forwarded: true, q: "1" }]);

  // authenticated + nonexistent site → honest 404, not a forward
  const ghost = (await serveSite(
    get(`/sites/ghost/api/databases`, { authorization: `Bearer ${TOKEN}` }),
    ctx,
    AUTH_TOKEN,
    { forwardApi },
  ))!;
  expect(ghost.status).toBe(404);
});

test("write rate limit: the 21st write in a window is 429 with code rate_limited; reads unaffected", async () => {
  const ctx = makeCtx();
  const d = createDatabase(ctx.db, { name: "Guestbook" });
  addProperty(ctx.db, d.id, { name: "Msg", type: "text" });
  const site = createSite(ctx.db, { name: "ratelimited", visibility: "public" });
  setSitePublicGrants(ctx.db, site.id, { v: 1, tables: [{ db: d.id, ops: ["read", "create"] }] });

  const ip = { ip: "203.0.113.9" };
  let last: Response | null = null;
  for (let i = 0; i < PUBLIC_WRITE_LIMIT + 1; i++) {
    last = (await serveSite(
      post(`/sites/ratelimited/api/records?db=${d.id}`, { Msg: `n${i}` }),
      ctx,
      AUTH_TOKEN,
      ip,
    ))!;
  }
  expect(last!.status).toBe(429);
  expect(((await last!.json()) as { code: string }).code).toBe("rate_limited");

  // reads ride a separate (larger) bucket — still fine
  const read = (await serveSite(get(`/sites/ratelimited/api/records?db=${d.id}`), ctx, AUTH_TOKEN, ip))!;
  expect(read.status).toBe(200);

  // another client IP is not throttled by this one's burn
  const other = (await serveSite(
    post(`/sites/ratelimited/api/records?db=${d.id}`, { Msg: "other" }),
    ctx,
    AUTH_TOKEN,
    { ip: "198.51.100.7" },
  ))!;
  expect(other.status).toBe(200);
});

test("FixedWindowLimiter: window reset restores the budget; capacity evicts instead of growing", () => {
  const lim = new FixedWindowLimiter(4);
  const t0 = 1_000_000;
  expect(lim.allow("b", "k", 2, 60_000, t0)).toBe(true);
  expect(lim.allow("b", "k", 2, 60_000, t0 + 1)).toBe(true);
  expect(lim.allow("b", "k", 2, 60_000, t0 + 2)).toBe(false); // over budget
  expect(lim.allow("b", "k", 2, 60_000, t0 + 60_001)).toBe(true); // window reset

  // bounded: churning keys caps at maxEntries
  for (let i = 0; i < 50; i++) lim.allow("b", `key${i}`, 1, 60_000, t0 + 60_002);
  expect(lim.size).toBeLessThanOrEqual(4);
});

test("read rate limit boundary: request #121 is 429", async () => {
  const ctx = makeCtx();
  const d = createDatabase(ctx.db, { name: "Guestbook" });
  addProperty(ctx.db, d.id, { name: "Msg", type: "text" });
  const site = createSite(ctx.db, { name: "readlimit", visibility: "public" });
  setSitePublicGrants(ctx.db, site.id, { v: 1, tables: [{ db: d.id, ops: ["read"] }] });
  const ip = { ip: "203.0.113.77" };
  let status = 0;
  for (let i = 0; i < PUBLIC_READ_LIMIT + 1; i++) {
    status = (await serveSite(get(`/sites/readlimit/api/records?db=${d.id}`), ctx, AUTH_TOKEN, ip))!.status;
  }
  expect(status).toBe(429);
});

// ---- two-node sync smoke -----------------------------------------------------------

test("two-node smoke: public_grants set on A replicates to B and serves there; junk register fails closed", async () => {
  const a = makeCtx("nodeaaaa");
  const b = makeCtx("nodebbbb");

  const d = createDatabase(a.db, { name: "Guestbook" });
  addProperty(a.db, d.id, { name: "Msg", type: "text" });
  const site = createSite(a.db, { name: "demo", visibility: "public" });
  await putFile(a.db, site.id, "index.html", { data: "<h1>hi</h1>" });
  setSitePublicGrants(a.db, site.id, { v: 1, tables: [{ db: d.id, ops: ["read", "create"] }] });

  ingest(b.db, changesSince(a.db, ""));

  // B serves the granted api token-free…
  const read = (await serveSite(get(`/sites/demo/api/records?db=${d.id}`), b, AUTH_TOKEN))!;
  expect(read.status).toBe(200);
  const write = (await serveSite(post(`/sites/demo/api/records?db=${d.id}`, { Msg: "via B" }), b, AUTH_TOKEN))!;
  expect(write.status).toBe(200);
  // …attributed to B's OWN derived guest id (never A's — HLC-collision safety)
  const created = (await write.json()) as { id: string };
  const node = b.db
    .query("SELECT DISTINCT node_id FROM crdt_changes WHERE dataset='records' AND row_id=?")
    .all(created.id) as { node_id: string }[];
  expect(node).toEqual([{ node_id: `gp-${site.id.slice(-8)}-nodebbbb` }]);

  // clearing the grants on A closes B after the next sync
  setSitePublicGrants(a.db, site.id, null);
  ingest(b.db, changesSince(a.db, ""));
  const closed = (await serveSite(get(`/sites/demo/api/records?db=${d.id}`), b, AUTH_TOKEN))!;
  expect(closed.status).toBe(401);

  // a malicious peer writes junk into the register → fail-closed on read
  b.db.query("UPDATE sites SET public_grants = ? WHERE id = ?").run('{"v":1,"tables":[{"db":"' + d.id + '","ops":["read","delete"]}]}', site.id);
  const junk = (await serveSite(get(`/sites/demo/api/records?db=${d.id}`), b, AUTH_TOKEN))!;
  expect(junk.status).toBe(401);
});

test("intent wrapper: $intent body creates like a plain body, and a retried intentId is idempotent", async () => {
  const ctx = makeCtx();
  const d = createDatabase(ctx.db, { name: "Guestbook" });
  addProperty(ctx.db, d.id, { name: "Msg", type: "text" });
  const site = createSite(ctx.db, { name: "demo", visibility: "public" });
  setSitePublicGrants(ctx.db, site.id, { v: 1, tables: [{ db: d.id, ops: ["create"] }] });

  const wrapped = { $intent: { id: "int_fixed99", submittedAt: Date.now() }, values: { Msg: "hi via intent" } };
  const r1 = (await serveSite(post(`/sites/demo/api/records?db=${d.id}`, wrapped), ctx, AUTH_TOKEN))!;
  expect(r1.status).toBe(200);
  const c1 = (await r1.json()) as { id: string; values: { Msg: string } };
  expect(c1.values.Msg).toBe("hi via intent");

  // Retry the SAME intentId (a dropped-response resend) → same row, no duplicate.
  const r2 = (await serveSite(post(`/sites/demo/api/records?db=${d.id}`, wrapped), ctx, AUTH_TOKEN))!;
  expect(r2.status).toBe(200);
  const c2 = (await r2.json()) as { id: string };
  expect(c2.id).toBe(c1.id);
  expect(listRecords(ctx.db, d.id)).toHaveLength(1); // exactly one, despite two POSTs

  // A plain body still works (legacy path, server mints the intentId).
  const r3 = (await serveSite(post(`/sites/demo/api/records?db=${d.id}`, { Msg: "plain" }), ctx, AUTH_TOKEN))!;
  expect(r3.status).toBe(200);
  expect(listRecords(ctx.db, d.id)).toHaveLength(2);

  for (const id of ["", "bad:key", "x".repeat(65), 42]) {
    const invalid = (await serveSite(
      post(`/sites/demo/api/records?db=${d.id}`, {
        $intent: { id, submittedAt: Date.now() },
        values: { Msg: "invalid id" },
      }),
      ctx,
      AUTH_TOKEN,
    ))!;
    expect(invalid.status).toBe(400);
  }
  expect(listRecords(ctx.db, d.id)).toHaveLength(2);
});
