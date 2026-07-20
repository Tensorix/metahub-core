import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { addPeer } from "./peers.ts";
import { createShareAction } from "./share-actions.ts";

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function db(): Database {
  const d = new Database(":memory:");
  runSchema(d);
  d.query("INSERT INTO meta (key,value) VALUES ('node_id','share-actions-test')").run();
  addPeer(d, {
    url: "https://peer.example",
    token: "peer-token",
    node_id: "peer-node",
  });
  return d;
}

describe("remote share creation recovery", () => {
  test("recovers a malformed POST response through its request id", async () => {
    const d = db();
    let requestId = "";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (init?.method === "POST") {
        requestId = JSON.parse(String(init.body)).requestId;
        return Response.json({ unexpected: true });
      }
      if (url.pathname === "/api/share/request") {
        expect(url.searchParams.get("id")).toBe(requestId);
        return Response.json({
          slug: "remote-slug",
          kind: "doc",
          permission: "view",
          transport: "server",
          hosting: "server",
          url: "https://peer.example/share/remote-slug",
          expiresAt: null,
          source: "remote",
        });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const out = await createShareAction(d, {
      kind: "doc",
      ref: "doc-does-not-need-to-exist-locally",
      server: "https://peer.example",
    });
    expect(out.slug).toBe("remote-slug");
    expect(out.url).toBe("https://peer.example/share/remote-slug");
    expect(requestId).toMatch(/^share_/);
  });

  test("recovers a committed share even when POST returns an error", async () => {
    const d = db();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (init?.method === "POST")
        return Response.json({ error: "response failed after commit" }, { status: 500 });
      if (url.pathname === "/api/share/request")
        return Response.json({
          slug: "recovered-slug",
          kind: "doc",
          permission: "view",
          transport: "server",
          hosting: "server",
          url: "https://peer.example/share/recovered-slug",
          expiresAt: null,
          source: "remote",
        });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const out = await createShareAction(d, {
      kind: "doc",
      ref: "remote",
      server: "https://peer.example",
    });
    expect(out.slug).toBe("recovered-slug");
  });

  test("compensates when neither POST nor request lookup is trustworthy", async () => {
    const d = db();
    let deleted = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (init?.method === "POST") return Response.json({ unexpected: true });
      if (init?.method === "DELETE" && url.pathname === "/api/share/request") {
        deleted = true;
        return Response.json({ ok: true, status: "revoked" });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await expect(
      createShareAction(d, {
        kind: "doc",
        ref: "remote",
        server: "https://peer.example",
      }),
    ).rejects.toThrow("invalid response");
    expect(deleted).toBe(true);
  });
});
