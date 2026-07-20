import { afterEach, describe, expect, test } from "bun:test";
import { verifyEdgeConnection } from "./edge-connect.ts";
import { EXPECTED_EDGE_WORKER_VERSION } from "./edge-config.ts";

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("Edge connection modes", () => {
  test("generic inbox hosts do not need the MetaHub Worker version", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      expect(path).toBe("/health");
      return Response.json({ ok: true, version: "third-party" });
    }) as typeof fetch;
    const out = await verifyEdgeConnection("https://inbox.example", "owner", "inbox");
    expect(out.capabilities).toEqual(["inbox"]);
  });

  test("Room-capable Edge connections require owner health and exact version", async () => {
    globalThis.fetch = (async () => Response.json({ ok: true, version: "old" })) as typeof fetch;
    await expect(
      verifyEdgeConnection("https://edge.example", "owner", "edge"),
    ).rejects.toThrow("incompatible");

    globalThis.fetch = (async () =>
      Response.json({ ok: true, version: EXPECTED_EDGE_WORKER_VERSION })) as typeof fetch;
    const out = await verifyEdgeConnection("https://edge.example", "owner", "edge");
    expect(out.capabilities).toEqual(["inbox", "room"]);
  });
});
