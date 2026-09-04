import { describe, expect, test } from "bun:test";
import type { ShareListItem } from "./api.ts";
import {
  EXPIRING_WINDOW_MS,
  countBySource,
  countByStatus,
  displayUrl,
  filterShares,
  fmtSnapshot,
  groupShares,
  matchesStatus,
  primaryAction,
  shareStatus,
  sortByExpiry,
  sourceLabel,
} from "./shares-model.ts";

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
const DAY = 86_400_000;
const HOUR = 3_600_000;

function row(p: Partial<ShareListItem> = {}): ShareListItem {
  return {
    slug: p.slug ?? "s",
    kind: "doc",
    target_id: "t",
    title: "Title",
    permission: "view",
    transport: "server",
    source: "本机服务器",
    sourceKind: "server",
    expiresAt: null,
    hasPassword: false,
    url: `https://mh.example.com/share/${p.slug ?? "s"}`,
    ...p,
  };
}

describe("shareStatus", () => {
  test("never-expiring is active/永久", () => {
    expect(shareStatus(row(), NOW)).toEqual({ state: "active", label: "永久", tone: "ok" });
  });
  test("now === expiresAt is expired (muted, not danger)", () => {
    const st = shareStatus(row({ expiresAt: NOW }), NOW);
    expect(st.state).toBe("expired");
    expect(st.tone).toBe("muted");
  });
  test("3-day threshold: just under → expiring, exactly → active", () => {
    expect(shareStatus(row({ expiresAt: NOW + EXPIRING_WINDOW_MS - 1 }), NOW).state).toBe("expiring");
    expect(shareStatus(row({ expiresAt: NOW + EXPIRING_WINDOW_MS }), NOW).state).toBe("active");
  });
  test("labels: days / hours / minutes", () => {
    expect(shareStatus(row({ expiresAt: NOW + 29 * DAY + HOUR }), NOW).label).toBe("29 天后过期");
    expect(shareStatus(row({ expiresAt: NOW + 5 * HOUR }), NOW).label).toBe("5 小时后过期");
    expect(shareStatus(row({ expiresAt: NOW + 90_000 }), NOW).label).toBe("1 分钟后过期");
  });
  test("lifecycle wins over expiry", () => {
    expect(shareStatus(row({ lifecycle: "cleanup_pending", expiresAt: NOW - DAY }), NOW)).toEqual({
      state: "cleanup_pending",
      label: "撤销中",
      tone: "warn",
    });
    expect(shareStatus(row({ lifecycle: "provisioning" }), NOW).tone).toBe("busy");
  });
});

describe("primaryAction matrix", () => {
  const cases: [ShareListItem["transport"], Partial<ShareListItem>, string][] = [
    ["server", {}, "复制链接"],
    ["s3", {}, "复制链接"],
    ["server", { expiresAt: NOW + HOUR }, "复制链接"],
    ["s3", { expiresAt: NOW + HOUR }, "续期"],
    ["server", { expiresAt: NOW - HOUR }, "重新分享"],
    ["s3", { expiresAt: NOW - HOUR }, "续期"],
    ["server", { lifecycle: "provisioning" }, "复制链接"],
    ["s3", { lifecycle: "provisioning" }, "复制链接"],
    ["server", { lifecycle: "cleanup_pending" }, "重试撤销"],
    ["s3", { lifecycle: "cleanup_pending" }, "重试撤销"],
  ];
  for (const [transport, patch, label] of cases) {
    test(`${transport} ${JSON.stringify(patch)} → ${label}`, () => {
      const s = row({ transport, ...patch });
      const pa = primaryAction(s, shareStatus(s, NOW));
      expect(pa.label).toBe(label);
      if (patch.lifecycle === "provisioning") expect(pa.disabled).toBe(true);
      if (patch.lifecycle === "cleanup_pending") expect(pa.danger).toBe(true);
    });
  }
  test("expired server → recreate kind; expired s3 → renew kind", () => {
    expect(primaryAction(row(), shareStatus(row({ expiresAt: NOW - 1 }), NOW)).kind).toBe("recreate");
    expect(primaryAction(row({ transport: "s3" }), shareStatus(row({ expiresAt: NOW - 1 }), NOW)).kind).toBe("renew");
  });
});

describe("sourceLabel / displayUrl / fmtSnapshot", () => {
  test("strips core prefixes and classifies by sourceKind", () => {
    expect(sourceLabel(row({ sourceKind: "bucket", source: "桶 metahub-1252110546" }))).toBe("存储桶 metahub-1252110546");
    expect(sourceLabel(row({ sourceKind: "room", source: "房间 abc" }))).toBe("Edge");
    expect(sourceLabel(row({ sourceKind: "room", source: "Edge Room（撤销待确认）" }))).toBe("Edge");
    expect(sourceLabel(row({ sourceKind: "peer", source: "MacBook" }))).toBe("设备 MacBook");
    expect(sourceLabel(row({ sourceKind: "server", source: "https://mh.example.com" }))).toBe("本机");
  });
  test("displayUrl drops scheme and trailing slash", () => {
    expect(displayUrl("https://mh.example.com/share/k3x9/")).toBe("mh.example.com/share/k3x9");
    expect(displayUrl("/share/k3x9")).toBe("/share/k3x9");
  });
  test("fmtSnapshot omits the year in the same year", () => {
    const ts = new Date(2026, 7, 21, 14, 2).getTime();
    const now = new Date(2026, 8, 4).getTime();
    expect(fmtSnapshot(ts, now)).toBe("快照 8/21 14:02");
    expect(fmtSnapshot(ts, new Date(2027, 0, 1).getTime())).toBe("快照 2026/8/21 14:02");
  });
});

describe("filter / count / group", () => {
  const list: ShareListItem[] = [
    row({ slug: "a", title: "Alpha", expiresAt: NOW + 30 * DAY }),
    row({ slug: "b", title: "Beta", expiresAt: NOW + DAY, transport: "s3", sourceKind: "bucket", source: "桶 b1", url: undefined }),
    row({ slug: "c", title: "Gamma", expiresAt: NOW - DAY }),
    row({ slug: "d", title: "Delta", expiresAt: NOW - 3 * DAY, sourceKind: "peer", source: "Mac" }),
    row({ slug: "e", title: "Eps" }),
    row({ slug: "f", title: "Zeta", lifecycle: "cleanup_pending", sourceKind: "room", source: "房间 f" }),
  ];

  test("filterShares: source axis and search over title / source label / url", () => {
    expect(filterShares(list, { source: "bucket", q: "" }).map((s) => s.slug)).toEqual(["b"]);
    expect(filterShares(list, { source: "all", q: "存储桶" }).map((s) => s.slug)).toEqual(["b"]);
    expect(filterShares(list, { source: "all", q: "share/c" }).map((s) => s.slug)).toEqual(["c"]);
    expect(filterShares(list, { source: "all", q: "  ALPHA " }).map((s) => s.slug)).toEqual(["a"]);
  });

  test("countByStatus is independent of the status filter; cleanup_pending only in all", () => {
    expect(countByStatus(list, NOW)).toEqual({ all: 6, active: 2, expiring: 1, expired: 2 });
    expect(matchesStatus(shareStatus(list[5]!, NOW), "active")).toBe(false);
    expect(matchesStatus(shareStatus(list[5]!, NOW), "all")).toBe(true);
  });

  test("countBySource lists only kinds present", () => {
    expect(countBySource(list)).toEqual({ server: 3, bucket: 1, peer: 1, room: 1 });
  });

  test("sortByExpiry: soonest first, never-expiring last, stable", () => {
    expect(sortByExpiry([list[0]!, list[4]!, list[1]!, list[5]!]).map((s) => s.slug)).toEqual(["b", "a", "e", "f"]);
  });

  test("groupShares: live sorted soonest-first, expired most-recent-first", () => {
    const g = groupShares(list, NOW);
    expect(g.live.map((s) => s.slug)).toEqual(["b", "a", "e", "f"]);
    expect(g.expired.map((s) => s.slug)).toEqual(["c", "d"]);
  });
});
