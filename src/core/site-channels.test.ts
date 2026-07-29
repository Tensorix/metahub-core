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

test("synced desired channels replace matching legacy projections without duplicates", () => {
  const input = base({
    visibility: "public",
    publishStates: [
      {
        targetBase: "https://legacy",
        url: "https://legacy/sites/x/",
        status: "ready",
      },
    ],
    shares: [share({ slug: "room-1", hosting: "room" })],
    storedChannels: [
      {
        id: "chan_public",
        audience: "public",
        hosting: "device",
        controllerNodeId: "a",
        targetRef: "b",
        canonicalUrl: "https://b/sites/x/",
        policyJson: '{"v":1,"tables":[]}',
        desiredState: "active",
        status: "ready",
      },
      {
        id: "chan_link",
        audience: "link",
        hosting: "edge",
        controllerNodeId: "a",
        targetRef: "room-1",
        canonicalUrl: "https://edge/room/room-1",
        policyJson:
          '{"permission":"view","hasPassword":false,"expiresAt":null}',
        desiredState: "active",
        status: "ready",
      },
    ],
  });
  const channels = siteChannels(input);
  expect(channels).toHaveLength(2);
  expect(channels.map((channel) => channel.id)).toEqual([
    "chan_public",
    "chan_link",
  ]);
});

test("revocation waiting for the controller remains visible and attention-first", () => {
  const input = base({
    storedChannels: [
      {
        id: "chan_link",
        audience: "link",
        hosting: "edge",
        controllerNodeId: "offline",
        targetRef: "room-1",
        canonicalUrl: "https://edge/room/room-1",
        policyJson: null,
        desiredState: "revoked",
        status: "waiting_controller",
      },
    ],
  });
  expect(siteChannels(input)[0]).toMatchObject({
    desiredState: "revoked",
    status: "waiting_controller",
  });
  expect(siteState(input)).toBe("cleanup_pending");
});

test("a failed local publish is not mislabeled as a pending rollback", () => {
  const input = base({
    storedChannels: [
      {
        id: "chan_failed",
        audience: "public",
        hosting: "device",
        controllerNodeId: "node-a",
        targetRef: "node-a",
        canonicalUrl: "https://bad.example/sites/x/",
        policyJson: null,
        desiredState: "revoked",
        status: "error",
      },
    ],
  });
  expect(siteState(input)).toBe("error");
});

test("a synced link policy becomes expired without relying on a local share row", () => {
  const input = base({
    now: 2_000,
    storedChannels: [
      {
        id: "chan_expired",
        audience: "link",
        hosting: "edge",
        controllerNodeId: "node-a",
        targetRef: "slug",
        canonicalUrl: "https://edge.example/room/slug",
        policyJson: JSON.stringify({
          permission: "view",
          hasPassword: false,
          expiresAt: 1_000,
        }),
        desiredState: "active",
        status: "ready",
      },
    ],
  });
  expect(siteChannels(input)[0]!.status).toBe("expired");
  expect(siteState(input)).toBe("private");
});
