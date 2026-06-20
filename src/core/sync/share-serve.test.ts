import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { createDocument, getDocument } from "../documents.ts";
import { createShare, hashSharePassword } from "../shares.ts";
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

  // The write carries the share's guest node id (replicates to owner as a guest).
  const rows = ctx.db
    .query("SELECT DISTINCT node_id FROM crdt_changes WHERE node_id = ?")
    .all(share.guest_node_id) as { node_id: string }[];
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
