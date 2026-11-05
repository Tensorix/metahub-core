import { expect, test } from "bun:test";
import { createSiteGate } from "./access";
test("bootstrap is single use and authority expires with the workspace", () => {
  const gate = createSiteGate("/_open/key", "session=secret"),
    host = "127.0.0.1:46123";
  const h = new Map([["host", host]]);
  expect(gate(true, host, h, "GET", "/api/databases")).toBe("deny");
  h.set("host", "external.example");
  expect(gate(true, host, h, "GET", "/_open/key")).toBe("deny");
  h.set("host", host);
  expect(gate(true, host, h, "GET", "/_open/key")).toBe("bootstrap");
  expect(gate(true, host, h, "GET", "/_open/key")).toBe("deny");
  h.set("cookie", "session=secret");
  expect(gate(true, host, h, "GET", "/api/databases")).toBe("serve");
  h.set("origin", "http://127.0.0.1:1111");
  expect(gate(true, host, h, "POST", "/api/documents")).toBe("deny");
  h.set("origin", "http://" + host);
  expect(gate(true, host, h, "POST", "/api/documents")).toBe("serve");
  expect(gate(false, host, h, "POST", "/api/documents")).toBe("deny");
});
