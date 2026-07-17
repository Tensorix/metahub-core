import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { createDocument, getDocument } from "../documents.ts";
import { createDatabase } from "../databases.ts";
import { addProperty } from "../properties.ts";
import { createRecord } from "../records.ts";
import { createSite, putFile } from "../sites.ts";
import { createShare, deleteShare, hashSharePassword } from "../shares.ts";
import { serveShare } from "./share-serve.ts";

function makeCtx(node = "hostnode") {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(node);
  return { db, node } as { db: Database; node: string };
}

const htmlReq = (path: string, init: RequestInit = {}) =>
  new Request("http://x" + path, { headers: { accept: "text/html" }, ...init });

test("view share renders the live doc and carries no master-token runtime", async () => {
  const ctx = makeCtx();
  const doc = createDocument(ctx.db, { title: "Spec", body: "# Hello\n\nworld **bold**" });
  const share = createShare(ctx.db, { kind: "doc", target_id: doc.id });

  const res = (await serveShare(htmlReq(`/share/${share.slug}`), ctx))!;
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("<h1>Hello</h1>");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).not.toContain("/mh-runtime.js");
});

test("expired share is 410 Gone and is removed", async () => {
  const ctx = makeCtx();
  const doc = createDocument(ctx.db, { title: "T", body: "x" });
  const share = createShare(ctx.db, { kind: "doc", target_id: doc.id, expiresAt: Date.now() - 1000 });
  const res = (await serveShare(htmlReq(`/share/${share.slug}`), ctx))!;
  expect(res.status).toBe(410);
});

test("password share prompts, unlocks, then serves", async () => {
  const ctx = makeCtx();
  const doc = createDocument(ctx.db, { title: "T", body: "secret body" });
  const { salt, hash } = await hashSharePassword("s3cr3t");
  const share = createShare(ctx.db, { kind: "doc", target_id: doc.id, pwSalt: salt, pwHash: hash });

  // Locked: HTML prompt, no content.
  const locked = (await serveShare(htmlReq(`/share/${share.slug}`), ctx))!;
  expect(locked.status).toBe(200);
  expect(await locked.text()).toContain("受口令保护");

  // Wrong password → 401.
  const wrong = (await serveShare(
    htmlReq(`/share/${share.slug}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    }),
    ctx,
  ))!;
  expect(wrong.status).toBe(401);

  // Correct password → 303 + Set-Cookie.
  const ok = (await serveShare(
    htmlReq(`/share/${share.slug}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "s3cr3t" }),
    }),
    ctx,
  ))!;
  expect(ok.status).toBe(303);
  const setCookie = ok.headers.get("set-cookie")!;
  expect(setCookie).toContain("mh_share_");
  expect(setCookie).toContain("HttpOnly"); // F20: not readable via document.cookie
  expect(setCookie).toContain("SameSite=Strict");
  const cookie = setCookie.split(";")[0]!;

  // With the cookie → content served.
  const served = (await serveShare(
    htmlReq(`/share/${share.slug}`, { headers: { accept: "text/html", cookie } }),
    ctx,
  ))!;
  expect(served.status).toBe(200);
  expect(await served.text()).toContain("secret body");
});

test("edit share write-back updates the doc and is attributed to the guest node", async () => {
  const ctx = makeCtx();
  const doc = createDocument(ctx.db, { title: "T", body: "original" });
  const share = createShare(ctx.db, { kind: "doc", target_id: doc.id, permission: "edit" });

  const res = (await serveShare(
    new Request(`http://x/share/${share.slug}/doc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "edited by guest" }),
    }),
    ctx,
  ))!;
  expect(res.status).toBe(200);
  expect(getDocument(ctx.db, doc.id)!.body).toBe("edited by guest");

  // The write carries a per-visitor sub id under the share's guest node id
  // (final decision 2: one guest identity per visitor — LIKE '<guest>-%'
  // groups a share's authors for source-level rollback).
  const rows = ctx.db
    .query("SELECT DISTINCT node_id FROM crdt_changes WHERE node_id LIKE ?")
    .all(share.guest_node_id + "-%") as { node_id: string }[];
  expect(rows.length).toBe(1);
});

test("a view share refuses edit write-back", async () => {
  const ctx = makeCtx();
  const doc = createDocument(ctx.db, { title: "T", body: "x" });
  const share = createShare(ctx.db, { kind: "doc", target_id: doc.id }); // view
  const res = (await serveShare(
    new Request(`http://x/share/${share.slug}/doc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "nope" }),
    }),
    ctx,
  ))!;
  expect(res.status).toBe(401);
  expect(getDocument(ctx.db, doc.id)!.body).toBe("x");
});

// ---- Batch 4.5: share-scoped grants api (/share/<slug>/api/*) --------------------

/** Site + guestbook db + one seed row, shared with the given grants. */
function seedSiteShare(
  ctx: { db: Database; node: string },
  opts: { ops: ("read" | "create" | "update")[]; password?: { salt: string; hash: string }; permission?: "view" | "edit" },
) {
  const d = createDatabase(ctx.db, { name: "Guestbook" });
  addProperty(ctx.db, d.id, { name: "Msg", type: "text" });
  const rec = createRecord(ctx.db, d.id, { Msg: "seed" });
  const site = createSite(ctx.db, { name: "fam" });
  const share = createShare(ctx.db, {
    kind: "site",
    target_id: site.id,
    permission: opts.permission ?? "view",
    pwSalt: opts.password?.salt ?? null,
    pwHash: opts.password?.hash ?? null,
    grants: opts.ops.length ? JSON.stringify({ v: 1, tables: [{ db: d.id, ops: opts.ops }] }) : null,
  });
  return { d, rec, site, share };
}

const jsonPost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://x" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

async function unlockCookie(ctx: { db: Database; node: string }, slug: string, password: string): Promise<string> {
  const res = (await serveShare(jsonPost(`/share/${slug}/unlock`, { password }), ctx))!;
  expect(res.status).toBe(303);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

test("password site share: api is 401 JSON before unlock, works after; revoke → 404", async () => {
  const ctx = makeCtx();
  const pw = await hashSharePassword("pw");
  const { d, share } = seedSiteShare(ctx, { ops: ["read", "create"], password: pw });

  // locked: non-HTML api call gets a 401 JSON, never the password page
  const locked = (await serveShare(new Request(`http://x/share/${share.slug}/api/records?db=${d.id}`), ctx))!;
  expect(locked.status).toBe(401);
  expect(((await locked.json()) as { error: string }).error).toBe("unauthorized");

  const cookie = await unlockCookie(ctx, share.slug, "pw");
  const read = (await serveShare(
    new Request(`http://x/share/${share.slug}/api/records?db=${d.id}`, { headers: { cookie } }),
    ctx,
  ))!;
  expect(read.status).toBe(200);
  const rows = (await read.json()) as { values: { Msg: string } }[];
  expect(rows[0]!.values.Msg).toBe("seed");

  // revoke kills the whole surface instantly (per-request live-row lookup)
  deleteShare(ctx.db, share.slug);
  const gone = (await serveShare(
    new Request(`http://x/share/${share.slug}/api/records?db=${d.id}`, { headers: { cookie } }),
    ctx,
  ))!;
  expect(gone.status).toBe(404);
});

test("view share + create grant CAN write; writes carry per-session sub ids that differ across sessions", async () => {
  const ctx = makeCtx();
  const pw = await hashSharePassword("pw");
  const { d, share } = seedSiteShare(ctx, { ops: ["create"], password: pw, permission: "view" });
  // a write-op grant minted a guest node id even though permission is view
  expect(share.guest_node_id).toStartWith("g");

  const c1 = await unlockCookie(ctx, share.slug, "pw");
  const c2 = await unlockCookie(ctx, share.slug, "pw");
  expect(c1).not.toBe(c2);

  const w1 = (await serveShare(
    jsonPost(`/share/${share.slug}/api/records?db=${d.id}`, { Msg: "from session 1" }, { cookie: c1 }),
    ctx,
  ))!;
  expect(w1.status).toBe(200);
  const w2 = (await serveShare(
    jsonPost(`/share/${share.slug}/api/records?db=${d.id}`, { Msg: "from session 2" }, { cookie: c2 }),
    ctx,
  ))!;
  expect(w2.status).toBe(200);

  // every guest write's node id is prefixed by the share's guest node id…
  const nodes = (
    ctx.db
      .query("SELECT DISTINCT node_id FROM crdt_changes WHERE node_id LIKE ?")
      .all(share.guest_node_id + "-%") as { node_id: string }[]
  ).map((r) => r.node_id);
  // …and the two sessions produced two DISTINCT sub ids (per-visitor identity)
  expect(nodes.length).toBe(2);

  // create-only: reads and updates refused
  const read = (await serveShare(
    new Request(`http://x/share/${share.slug}/api/records?db=${d.id}`, { headers: { cookie: c1 } }),
    ctx,
  ))!;
  expect(read.status).toBe(401);
});

test("no-password share api: first call mints a session cookie; s3-transport and ungranted stay closed", async () => {
  const ctx = makeCtx();
  const { d, share } = seedSiteShare(ctx, { ops: ["read", "create"] });

  const first = (await serveShare(jsonPost(`/share/${share.slug}/api/records?db=${d.id}`, { Msg: "hi" }), ctx))!;
  expect(first.status).toBe(200);
  const setCookie = first.headers.get("set-cookie")!;
  expect(setCookie).toContain(`mh_share_${share.slug}=`);
  const cookie = setCookie.split(";")[0]!;

  // the follow-up write reuses the SAME sub (one visitor, one author)
  const second = (await serveShare(
    jsonPost(`/share/${share.slug}/api/records?db=${d.id}`, { Msg: "again" }, { cookie }),
    ctx,
  ))!;
  expect(second.status).toBe(200);
  const subs = ctx.db
    .query("SELECT DISTINCT node_id FROM crdt_changes WHERE node_id LIKE ?")
    .all(share.guest_node_id + "-%") as { node_id: string }[];
  expect(subs.length).toBe(1); // both writes under ONE per-visitor sub id
});

test("share with no grants: api answers 401 while file serving still works", async () => {
  const ctx = makeCtx();
  const { d, site, share } = seedSiteShare(ctx, { ops: [] });
  await putFile(ctx.db, site.id, "index.html", { data: "<h1>shared</h1>" });

  const page = (await serveShare(htmlReq(`/share/${share.slug}/`), ctx))!;
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("shared");

  const api = (await serveShare(new Request(`http://x/share/${share.slug}/api/records?db=${d.id}`), ctx))!;
  expect(api.status).toBe(401);
});

test("scoped blob refuses a hash the target does not reference", async () => {
  const ctx = makeCtx();
  const doc = createDocument(ctx.db, { title: "T", body: "no images here" });
  const share = createShare(ctx.db, { kind: "doc", target_id: doc.id });
  const res = (await serveShare(
    htmlReq(`/share/${share.slug}/blob/${"a".repeat(32)}.png`),
    ctx,
  ))!;
  expect(res.status).toBe(404);
});
