import { test, expect } from "bun:test";
import { siteChannels, siteState, shareChannel, type SiteChannelInput } from "./site-channels.ts";
import type { ShareListItem } from "./sync/share-actions.ts";

const base = (over: Partial<SiteChannelInput> = {}): SiteChannelInput => ({
  visibility: null,
  publishStates: [],
  pendingRollbacks: [],
  shares: [],
  now: 1_000_000,
  ...over,
});

const share = (over: Partial<ShareListItem> = {}): ShareListItem => ({
  slug: "abc123",
  kind: "site",
  target_id: "site_x",
  title: "x",
  permission: "view",
  transport: "server",
  source: "本机服务器",
  sourceKind: "server",
  hosting: "server",
  expiresAt: null,
  hasPassword: false,
  url: "http://h/share/abc123",
  ...over,
});

test("private site with no shares → private, no channels", () => {
  expect(siteState(base())).toBe("private");
  expect(siteChannels(base())).toEqual([]);
});

test("default-deny: only exactly 'public' counts as public", () => {
  expect(siteState(base({ visibility: "PUBLIC" }))).toBe("private");
  expect(siteState(base({ visibility: "public" }))).toBe("public_unverified");
});

test("public with no publish state → single unverified anyone-channel", () => {
  const ch = siteChannels(base({ visibility: "public" }));
  expect(ch).toHaveLength(1);
  expect(ch[0]).toMatchObject({ audience: "anyone", status: "unverified", url: null });
});

test("public ready / syncing publish states map through", () => {
  const ready = base({
    visibility: "public",
    publishStates: [{ targetBase: "http://a", url: "http://a/sites/x/", status: "ready" }],
  });
  expect(siteState(ready)).toBe("device_live");
  const syncing = base({
    visibility: "public",
    publishStates: [{ targetBase: "http://a", url: "http://a/sites/x/", status: "syncing" }],
  });
  expect(siteState(syncing)).toBe("device_syncing");
});

test("pending rollback outranks everything", () => {
  const input = base({
    visibility: "public",
    publishStates: [{ targetBase: "http://a", url: "http://a/sites/x/", status: "ready" }],
    pendingRollbacks: [{ peerUrl: "http://b", targetUrl: "http://b/sites/x/", lastError: "boom" }],
    shares: [share({ hosting: "room", lifecycle: "active" })],
  });
  expect(siteState(input)).toBe("rollback_pending");
  expect(siteChannels(input)[0]!.status).toBe("rollback_pending");
});

test("room lifecycle: active → room_live; provisioning/cleanup_pending surface", () => {
  expect(siteState(base({ shares: [share({ hosting: "room", lifecycle: "active" })] }))).toBe("room_live");
  expect(siteState(base({ shares: [share({ hosting: "room", lifecycle: "provisioning" })] }))).toBe("provisioning");
  expect(siteState(base({ shares: [share({ hosting: "room", lifecycle: "cleanup_pending" })] }))).toBe("cleanup_pending");
});

test("plain link share → link_only; expired share does not count as live", () => {
  expect(siteState(base({ shares: [share()] }))).toBe("link_only");
  expect(siteState(base({ shares: [share({ expiresAt: 999 })] }))).toBe("private");
});

test("rooms sort ahead of plain links in the channel list", () => {
  const ch = siteChannels(
    base({ shares: [share(), share({ slug: "r1", hosting: "room", lifecycle: "active" })] }),
  );
  expect(ch.map((c) => c.hosting)).toEqual(["room", "device"]);
});

test("shareChannel carries permission/password/expiry through", () => {
  const c = shareChannel(
    share({ permission: "edit", hasPassword: true, expiresAt: 2_000_000 }),
    1_000_000,
  );
  expect(c).toMatchObject({
    audience: "link",
    permission: "edit",
    hasPassword: true,
    expiresAt: 2_000_000,
    status: "ready",
  });
});
