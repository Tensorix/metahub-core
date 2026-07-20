import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../../core/db.ts";
import { parseGrantSet } from "../../core/grants-core.ts";
import { createSite, resolveSite, setSitePublicGrants } from "../../core/sites.ts";
import { addPeer } from "../../core/sync/peers.ts";
import type { RouteCtx } from "../../core/sync/routes.ts";
import { pollSite, siteHostingRoutes } from "./site-hosting-routes.ts";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function db(): Database {
  const d = new Database(":memory:");
  runSchema(d);
  d.query("INSERT INTO meta (key,value) VALUES ('node_id','node-host')").run();
  return d;
}

function route(method: string, path: string) {
  return siteHostingRoutes.find((r) => r.method === method && r.path === path)!;
}

async function call(
  method: string,
  path: string,
  body: unknown,
  ctx: RouteCtx,
): Promise<Response> {
  return route(method, path).handler(
    new Request(`http://local.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx,
  ) as Promise<Response>;
}

describe("site hosting routes", () => {
  test("site readiness is bounded and accepts only 2xx", async () => {
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.signal) {
        return await new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      return new Response(null, { status: 302 });
    }) as typeof fetch;
    expect(await pollSite("https://slow.example/sites/demo/", { budgetMs: 20, attemptMs: 5 })).toBe(
      false,
    );

    globalThis.fetch = (async () => new Response(null, { status: 302 })) as typeof fetch;
    expect(await pollSite("https://redirect.example/sites/demo/", { budgetMs: 5 })).toBe(false);

    globalThis.fetch = (async () => new Response("ok", { status: 204 })) as typeof fetch;
    expect(await pollSite("https://ready.example/sites/demo/", { budgetMs: 20 })).toBe(true);
  });

  test("health verification rejects redirects and metadata endpoints", async () => {
    const d = db();
    globalThis.fetch = (async () =>
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } })) as typeof fetch;
    const redirected = await call(
      "POST",
      "/api/site-hosting/verify",
      { url: "https://redirect.example" },
      { db: d, node: "node-host", allowRemoteSiteHosting: true },
    );
    expect(redirected.status).toBe(502);

    const metadata = await call(
      "POST",
      "/api/site-hosting/verify",
      { url: "http://169.254.169.254" },
      { db: d, node: "node-host", allowRemoteSiteHosting: true },
    );
    expect(metadata.status).toBe(400);

    globalThis.fetch = (async () =>
      new Response("x".repeat(16 * 1024 + 1), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const oversized = await call(
      "POST",
      "/api/site-hosting/verify",
      { url: "https://large-health.example" },
      { db: d, node: "node-host", allowRemoteSiteHosting: true },
    );
    expect(oversized.status).toBe(502);
  });

  test("publishes only after node verification and returns a complete reachable URL", async () => {
    const d = db();
    const site = createSite(d, { name: "demo" });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/health")
        return Response.json({ ok: true, node: "node-host" });
      if (url.pathname === "/sites/demo/") return new Response("<h1>ok</h1>");
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;

    const res = await call(
      "POST",
      "/api/site/publish",
      {
        siteId: site.id,
        access: "public",
        targetBase: "https://public.example",
        grants: { v: 1, tables: [] },
      },
      { db: d, node: "node-host", allowRemoteSiteHosting: true },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      access: "public",
      status: "ready",
      url: "https://public.example/sites/demo/",
      host: "https://public.example",
    });
    expect(resolveSite(d, site.id).visibility).toBe("public");
    const hosting = await route("GET", "/api/site-hosting").handler(
      new Request("http://local.test/api/site-hosting"),
      { db: d, node: "node-host", allowRemoteSiteHosting: true },
    );
    expect(
      ((await hosting.json()) as { publishedSites: unknown[] }).publishedSites,
    ).toEqual([
      expect.objectContaining({
        siteId: site.id,
        status: "ready",
        url: "https://public.example/sites/demo/",
      }),
    ]);
  });

  test("restores visibility and grants when paired-device sync fails", async () => {
    const d = db();
    const site = createSite(d, { name: "demo" });
    setSitePublicGrants(d, site.id, {
      v: 1,
      tables: [{ db: "db_before", ops: ["read"] }],
    });
    addPeer(d, {
      url: "https://peer.example",
      token: "peer-token",
      node_id: "peer-node",
    });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/health")
        return Response.json({ ok: true, node: "peer-node" });
      if (url.pathname === "/sync")
        return Response.json({ error: "sync interrupted" }, { status: 500 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;

    const res = await call(
      "POST",
      "/api/site/publish",
      {
        siteId: site.id,
        access: "public",
        targetBase: "https://peer.example",
        grants: { v: 1, tables: [{ db: "db_after", ops: ["read"] }] },
      },
      { db: d, node: "node-host", allowRemoteSiteHosting: true },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      access: "private",
      status: "rollback_pending",
      url: null,
    });
    expect(resolveSite(d, site.id).visibility).toBe("private");
    expect(parseGrantSet(resolveSite(d, site.id).public_grants)).toEqual({
      v: 1,
      tables: [{ db: "db_before", ops: ["read"] }],
    });
    const hosting = await route("GET", "/api/site-hosting").handler(
      new Request("http://local.test/api/site-hosting"),
      { db: d, node: "node-host", allowRemoteSiteHosting: true },
    );
    expect(((await hosting.json()) as { pendingRollbacks: unknown[] }).pendingRollbacks).toHaveLength(
      1,
    );

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/sync")
        return Response.json({ node_id: "peer-node", changes: [], cursor: 0 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const recovered = await call(
      "POST",
      "/api/site/publish/recover",
      { siteId: site.id, targetBase: "https://peer.example" },
      { db: d, node: "node-host", allowRemoteSiteHosting: true },
    );
    expect(await recovered.json()).toMatchObject({ status: "private" });
  });

  test("refuses a paired device whose node identity was not saved", async () => {
    const d = db();
    const site = createSite(d, { name: "missing-node" });
    addPeer(d, { url: "https://peer.example", token: "peer-token" });
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return Response.json({ ok: true, node: "peer-node" });
    }) as typeof fetch;
    const res = await call(
      "POST",
      "/api/site/publish",
      {
        siteId: site.id,
        access: "public",
        targetBase: "https://peer.example",
      },
      { db: d, node: "node-host", allowRemoteSiteHosting: true },
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("重新配对"),
    });
    expect(fetched).toBe(false);
  });

  test("Desktop sidecar refuses LAN/public bases before making a request", async () => {
    const d = db();
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return Response.json({ ok: true, node: "node-host" });
    }) as typeof fetch;
    const res = await call(
      "POST",
      "/api/site-hosting/verify",
      { url: "https://desktop-tunnel.example" },
      { db: d, node: "node-host", allowRemoteSiteHosting: false },
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "invalid_input",
    });
    expect(fetched).toBe(false);
  });
});
