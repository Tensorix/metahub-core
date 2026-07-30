import { test, expect } from "bun:test";
import { channelAudienceIcon, siteCardAddress } from "./site-status.ts";
import type { SiteChannel } from "../core/site-channels.ts";

const chan = (over: Partial<SiteChannel> = {}): SiteChannel => ({
  audience: "link",
  hosting: "device",
  url: "http://h/share/secret1",
  status: "ready",
  source: "本机服务器",
  ...over,
});

const pub = (over: Partial<SiteChannel> = {}): SiteChannel =>
  chan({ audience: "anyone", url: "http://h/sites/demo/", ...over });

test("rule 1: exactly one ready public URL is the card address", () => {
  expect(siteCardAddress([pub()])).toEqual({ kind: "public", url: "http://h/sites/demo/" });
  // Private links alongside never displace or leak into the public slot.
  expect(siteCardAddress([pub(), chan()])).toEqual({
    kind: "public",
    url: "http://h/sites/demo/",
  });
});

test("rule 2: several public addresses → count only", () => {
  expect(
    siteCardAddress([pub(), pub({ url: "https://edge.example/sites/demo/" })]),
  ).toEqual({ kind: "public_multi", count: 2 });
});

test("rule 3: only private links → count, NEVER the capability URL", () => {
  const addr = siteCardAddress([chan(), chan({ url: "http://h/share/secret2", status: "syncing" })]);
  expect(addr).toEqual({ kind: "links_only", count: 2 });
  expect(JSON.stringify(addr)).not.toContain("/share/");
});

test("rule 4: nothing live → preview", () => {
  expect(siteCardAddress([])).toEqual({ kind: "preview" });
});

test("revoked, expired, and unready channels never count", () => {
  expect(
    siteCardAddress([
      pub({ desiredState: "revoked" }),
      pub({ status: "syncing" }), // public not yet verified → no address to show
      chan({ status: "expired" }),
      chan({ desiredState: "revoked" }),
      chan({ status: "cleanup_pending" }),
    ]),
  ).toEqual({ kind: "preview" });
});

test("a public channel without a URL yet cannot be the card address", () => {
  expect(siteCardAddress([pub({ url: null })])).toEqual({ kind: "preview" });
});

test("audience icon: globe for public, lock for capability links", () => {
  expect(channelAudienceIcon({ audience: "anyone" })).toBe("globe");
  expect(channelAudienceIcon({ audience: "link" })).toBe("lock");
});
