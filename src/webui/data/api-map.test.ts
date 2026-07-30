import { test, expect } from "bun:test";
import { mapApiRequest } from "./api-map.ts";

const map = (
  method: string,
  path: string,
  query: Record<string, string> = {},
  body: Record<string, unknown> | null = null,
) => mapApiRequest(method, path, new URLSearchParams(query), body);

test("sites management maps to replica ops", () => {
  expect(map("GET", "/api/sites")).toEqual({ op: "listSites", args: [] });
  expect(map("GET", "/api/site/files", { site: "demo" })).toEqual({
    op: "listSiteFiles",
    args: ["demo"],
  });
  expect(map("POST", "/api/sites", {}, { name: "x" })).toEqual({
    op: "createSite",
    args: [{ name: "x" }],
  });
  expect(map("PATCH", "/api/site", { id: "site_1" }, { title: "T" })).toEqual({
    op: "updateSite",
    args: ["site_1", { title: "T" }],
  });
  expect(map("DELETE", "/api/site", { id: "site_1" })).toEqual({
    op: "deleteSite",
    args: ["site_1"],
  });
  expect(map("GET", "/api/site/grants", { id: "site_1" })).toEqual({
    op: "getSiteGrants",
    args: ["site_1"],
  });
  expect(map("PUT", "/api/site/grants", { id: "site_1" }, { v: 1, tables: [] })).toEqual({
    op: "setSiteGrants",
    args: ["site_1", { v: 1, tables: [] }],
  });
  expect(map("GET", "/api/site-hosting")).toEqual({ op: "siteHosting", args: [] });
  expect(map("PATCH", "/api/site/channel", {}, { id: "chan_1", desiredState: "revoked" })).toEqual({
    op: "revokeSiteChannel",
    args: ["chan_1"],
  });
  expect(map("DELETE", "/api/site/file", { site: "demo", path: "index.html" })).toEqual({
    op: "deleteSiteFile",
    args: ["demo", "index.html"],
  });
});

test("shares map to the replica's own rows", () => {
  expect(map("GET", "/api/shares", { target: "doc_1" })).toEqual({
    op: "listLocalShares",
    args: ["doc_1"],
  });
  expect(map("POST", "/api/share", {}, { kind: "doc", ref: "doc_1" })).toEqual({
    op: "createLocalShare",
    args: [{ kind: "doc", ref: "doc_1" }],
  });
  expect(map("DELETE", "/api/share", { slug: "abc" })).toEqual({
    op: "revokeLocalShare",
    args: ["abc"],
  });
  expect(map("DELETE", "/api/share/managed", { slug: "abc" })).toEqual({
    op: "revokeLocalShare",
    args: ["abc"],
  });
});

test("server-only endpoints deliberately stay unmapped", () => {
  expect(map("POST", "/api/site/publish", {}, { siteId: "s" })).toBeNull();
  expect(map("POST", "/api/site/publish/recover", {}, {})).toBeNull();
  expect(map("PUT", "/api/site/file", { site: "demo", path: "a.png" })).toBeNull(); // upload
  expect(map("POST", "/api/site-hosting", {}, {})).toBeNull();
  expect(map("GET", "/api/peers")).toBeNull();
});
