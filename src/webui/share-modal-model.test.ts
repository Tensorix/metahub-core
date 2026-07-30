import { test, expect } from "bun:test";
import {
  channelRowView,
  legacyShareRowView,
  deviceOptionState,
  hostingPlan,
  type HostingPlanInput,
} from "./share-modal-model.ts";
import type { SiteChannel } from "../core/site-channels.ts";
import type { EdgeStatus, ShareListItem } from "./api.ts";
import type { Scope } from "./data/scopes.ts";

const link = (over: Partial<SiteChannel> = {}): SiteChannel => ({
  id: "chan_1",
  audience: "link",
  hosting: "device",
  url: "http://h/share/sec1",
  status: "ready",
  source: "本机服务器",
  slug: "sec1",
  permission: "view",
  hasPassword: false,
  expiresAt: null,
  desiredState: "active",
  ...over,
});

const edgeStatus = (rooms: { slug: string; lastSuccessAt: number | null }[]): EdgeStatus =>
  ({
    configured: true,
    expectedVersion: "1",
    aligned: true,
    reachable: true,
    managed: false,
    capabilities: ["inbox", "room"],
    rooms: rooms.map((r) => ({ slug: r.slug, url: `https://e/r/${r.slug}`, status: "ok", lastSuccessAt: r.lastSuccessAt, error: null })),
    defaults: {},
  }) as unknown as EdgeStatus;

test("ready link row: copy/open/revoke, meta carries permission+expiry", () => {
  const v = channelRowView(link({ hasPassword: true, expiresAt: 1_700_000_000_000 }));
  expect(v.actions).toEqual(["copy", "open", "revoke"]);
  expect(v.icon).toBe("lock");
  expect(v.metaLine).toContain("只读");
  expect(v.metaLine).toContain("🔒");
  expect(v.metaLine).toContain("至 ");
});

test("expired link: NO copy/open, recreate offered, url withheld", () => {
  const v = channelRowView(link({ status: "expired" }));
  expect(v.actions).toEqual(["recreate", "revoke"]);
  expect(v.url).toBeNull();
  expect(v.warnLine).toContain("已过期");
  expect(v.warnLine).toContain("重新创建");
});

test("revoke in flight: waiting_controller explains itself, no actions", () => {
  const v = channelRowView(link({ desiredState: "revoked", status: "waiting_controller" }));
  expect(v.actions).toEqual([]);
  expect(v.warnLine).toContain("等待控制设备");
});

test("public channel: globe + stopPublic instead of revoke", () => {
  const v = channelRowView(link({ audience: "anyone", url: "http://h/sites/demo/" }));
  expect(v.icon).toBe("globe");
  expect(v.badge).toBe("公开");
  expect(v.actions).toEqual(["copy", "open", "stopPublic"]);
});

test("Edge room row separates availability from freshness", () => {
  const v = channelRowView(link({ hosting: "room", slug: "r1" }), {
    edge: edgeStatus([{ slug: "r1", lastSuccessAt: Date.now() - 3 * 60_000 }]),
  });
  expect(v.metaLine).toContain("设备离线仍可访问");
  expect(v.metaLine).toContain("内容同步于");
  const cold = channelRowView(link({ hosting: "room", slug: "r2" }), {
    edge: edgeStatus([]),
  });
  expect(cold.metaLine).toContain("等待首次同步");
});

const s3Share = (over: Partial<ShareListItem> = {}): ShareListItem => ({
  slug: "snap1",
  kind: "doc",
  target_id: "doc_1",
  title: "Doc",
  permission: "view",
  transport: "s3",
  source: "桶 r2",
  sourceKind: "bucket",
  hosting: "s3",
  expiresAt: Date.now() + 86_400_000,
  hasPassword: false,
  contentUpdatedAt: Date.now() - 86_400_000,
  ...over,
});

test("s3 snapshot row: content age ≠ link validity; renew and refresh split", () => {
  const v = legacyShareRowView(s3Share());
  expect(v.badge).toBe("快照链接");
  expect(v.metaLine).toContain("内容生成于");
  expect(v.metaLine).toContain("链接有效至");
  expect(v.actions).toEqual(["copyShare", "renewLink", "refreshExport", "revokeShare"]);
});

test("expired server share: no copy, recreate offered", () => {
  const v = legacyShareRowView(
    s3Share({ transport: "server", hosting: "server", url: "http://h/share/x", expiresAt: 1 }),
    1_000,
  );
  expect(v.actions).toEqual(["recreate", "revokeShare"]);
  expect(v.url).toBeNull();
});

// ── hostingPlan ───────────────────────────────────────────────────────────────

const scope = (over: Partial<Scope> = {}): Scope =>
  ({
    id: "server",
    kind: "server",
    label: "本机",
    subtitle: "当前连接的工作区",
    icon: "globe",
    isDefault: true,
    routeOp: "local",
    deleteSemantics: "purge",
    ...over,
  }) as Scope;

const planInput = (over: Partial<HostingPlanInput> = {}): HostingPlanInput => ({
  access: "link",
  hostingAuto: true,
  hosting: "device",
  selId: "server",
  targets: [scope()],
  noOrigin: false,
  edge: null,
  serverEntryOk: true,
  ...over,
});

test("never-synced device stays listed (greyed) instead of vanishing", () => {
  const fresh = scope({
    id: "peer:box",
    isDefault: false,
    label: "盒子",
    availability: { enabled: true, lastStatus: null, lastSuccessAt: null },
  });
  expect(deviceOptionState(fresh)).toBe("never_synced");
  const plan = hostingPlan(planInput({ targets: [fresh], noOrigin: true }));
  expect(plan.allDeviceTargets).toHaveLength(1);
  expect(plan.usableDeviceTargets).toHaveLength(0);
});

test("only waiting devices → blocked message offers sync, not a dead end", () => {
  const fresh = scope({
    id: "peer:box",
    isDefault: false,
    label: "盒子",
    availability: { enabled: true, lastStatus: null, lastSuccessAt: null },
  });
  const plan = hostingPlan(
    planInput({ targets: [fresh], hostingAuto: false, hosting: "device" }),
  );
  expect(plan.deviceBlocked).toContain("请先同步成功");
  expect(plan.wantsSyncNow).toBe(true);
});

test("public access always publishes to a device, never Edge", () => {
  const plan = hostingPlan(
    planInput({
      access: "public",
      edge: { configured: true, capabilities: ["room"] },
    }),
  );
  expect(plan.effHosting).toBe("device");
});

test("link access auto-picks a usable Edge; falls back to device", () => {
  const withEdge = hostingPlan(planInput({ edge: { configured: true, capabilities: ["room"] } }));
  expect(withEdge.effHosting).toBe("edge");
  const inboxOnly = hostingPlan(planInput({ edge: { configured: true, capabilities: ["inbox"] } }));
  expect(inboxOnly.effHosting).toBe("device");
  expect(inboxOnly.blocked).toBe("");
});

test("no-origin + public → clear device block; edge stays open for links", () => {
  const plan = hostingPlan(planInput({ access: "public", noOrigin: true }));
  expect(plan.deviceBlocked).toContain("在线主节点");
  const linkPlan = hostingPlan(
    planInput({ noOrigin: true, edge: { configured: true, capabilities: ["room"] } }),
  );
  expect(linkPlan.effHosting).toBe("edge");
  expect(linkPlan.blocked).toBe("");
});

test("edge loading (null) never flashes a warning", () => {
  const plan = hostingPlan(planInput({ hostingAuto: false, hosting: "edge", edge: null }));
  expect(plan.edgeBlocked).toBe("");
});
