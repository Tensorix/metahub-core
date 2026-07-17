import { test, expect } from "bun:test";
import { detectBase, createClient } from "./client.ts";

test("detectBase maps the three mounts", () => {
  // site mount → its prefix (owner full api / public granted api)
  expect(detectBase("/sites/demo/")).toBe("/sites/demo");
  expect(detectBase("/sites/demo/index.html")).toBe("/sites/demo");
  expect(detectBase("/sites/my-app/deep/route")).toBe("/sites/my-app");
  // share mount → its prefix (grant-scoped, session-gated)
  expect(detectBase("/share/abc123xyz/")).toBe("/share/abc123xyz");
  expect(detectBase("/share/abc123xyz/page.html")).toBe("/share/abc123xyz");
  // room mount → its prefix (grant-scoped + live WS pokes)
  expect(detectBase("/r/abc123xyz/")).toBe("/r/abc123xyz");
  expect(detectBase("/r/abc123xyz/index.html")).toBe("/r/abc123xyz");
  // everything else → the root api
  expect(detectBase("/")).toBe("");
  expect(detectBase("/app")).toBe("");
  expect(detectBase("/docs")).toBe("");
  expect(detectBase("/sites")).toBe(""); // bare /sites is not a mount
  expect(detectBase("/sitesX/nope")).toBe("");
  // no DOM (this test runs without location) → root
  expect(detectBase()).toBe("");
});

test("createClient exposes the full typed method surface", () => {
  const api = createClient({ baseUrl: "http://127.0.0.1:1" });
  for (const m of [
    "listDatabases",
    "listProperties",
    "listRecords",
    "getRecord",
    "createRecord",
    "updateRecord",
    "listDocuments",
    "getDocument",
    "search",
    "onUpdate",
  ]) {
    expect(typeof (api as Record<string, unknown>)[m]).toBe("function");
  }
});
