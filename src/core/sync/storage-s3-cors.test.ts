// Unit tests for the PutBucketCors XML builder — pure (no network), so they run
// without a real bucket. Covers the SET vs UNION (merge) semantics that let a
// second origin attach the same bucket without clobbering the first's CORS.

import { test, expect } from "bun:test";
import { buildCorsXml } from "./storage-s3-sign.ts";

const A = "https://homelab.example";
const B = "https://mh.tensorix.org";
const origins = (xml: string) =>
  [...xml.matchAll(/<AllowedOrigin>([\s\S]*?)<\/AllowedOrigin>/g)].map((m) => m[1]!);

test("empty bucket: sets the managed rule with the given origins", () => {
  const xml = buildCorsXml(null, [A], false);
  expect(xml).toContain("<ID>metahub-pwa</ID>");
  expect(origins(xml)).toEqual([A]);
});

test("merge=false replaces the managed rule's origins (CLI set semantics)", () => {
  const existing = buildCorsXml(null, [A], false);
  const xml = buildCorsXml(existing, [B], false);
  expect(origins(xml)).toEqual([B]); // A gone
});

test("merge=true unions with existing managed origins (second origin attaches)", () => {
  const existing = buildCorsXml(null, [A], false);
  const xml = buildCorsXml(existing, [B], true);
  expect(origins(xml).sort()).toEqual([A, B].sort());
});

test("merge=true dedups a re-add of the same origin", () => {
  const existing = buildCorsXml(null, [A], false);
  const xml = buildCorsXml(existing, [A], true);
  expect(origins(xml)).toEqual([A]);
});

test("a wildcard collapses the origin set", () => {
  const existing = buildCorsXml(null, [A], false);
  const xml = buildCorsXml(existing, ["*"], true);
  expect(origins(xml)).toEqual(["*"]);
});

test("non-managed (user) CORS rules are preserved", () => {
  const userRule = "<CORSRule><ID>my-own</ID><AllowedOrigin>https://kept.example</AllowedOrigin></CORSRule>";
  const existing = `<CORSConfiguration>${userRule}</CORSConfiguration>`;
  const xml = buildCorsXml(existing, [A], true);
  expect(xml).toContain("<ID>my-own</ID>");
  expect(xml).toContain("https://kept.example");
  expect(xml).toContain("<ID>metahub-pwa</ID>");
  expect(origins(xml)).toContain(A);
});
