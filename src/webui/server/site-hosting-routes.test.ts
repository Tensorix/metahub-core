import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../../core/db.ts";
import { parseGrantSet } from "../../core/grants-core.ts";
import { createSite, resolveSite, setSitePublicGrants } from "../../core/sites.ts";
import { addPeer } from "../../core/sync/peers.ts";
import type { RouteCtx } from "../../core/sync/routes.ts";
import { siteHostingRoutes } from "./site-hosting-routes.ts";

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
    expect(res.status).toBe(502);
    expect(resolveSite(d, site.id).visibility).toBe("private");
    expect(parseGrantSet(resolveSite(d, site.id).public_grants)).toEqual({
      v: 1,
      tables: [{ db: "db_before", ops: ["read"] }],
    });
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
