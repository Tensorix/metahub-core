// Pure view-model layer for the publish/share dialog. Everything here is a
// plain function over already-fetched data so the row rendering and hosting
// derivation are unit-testable without a DOM or api mocks (share-modal.tsx
// keeps only wiring + JSX).

import type { EdgeStatus, GrantOp, GrantSet, ShareListItem } from "./api.ts";
import type { Scope } from "./data/scopes.ts";
import { CHANNEL_STATUS_LABEL, type SiteChannel } from "./site-status.ts";
import { timeAgo } from "./date.ts";

export const EXPIRY: { label: string; ms: number | null }[] = [
  { label: "永不过期", ms: null },
  { label: "1 小时", ms: 3_600_000 },
  { label: "24 小时", ms: 86_400_000 },
  { label: "7 天", ms: 604_800_000 },
  { label: "30 天", ms: 2_592_000_000 },
];

/** Per-database grant edits for a site share: dbId → enabled ops. */
export type GrantDraft = Map<string, Set<GrantOp>>;

export function draftToGrantSet(draft: GrantDraft): GrantSet | null {
  const tables = [...draft.entries()]
    .filter(([, ops]) => ops.size > 0)
    .map(([db, ops]) => ({
      db,
      ops: (["read", "create", "update"] as GrantOp[]).filter((o) => ops.has(o)),
    }));
  return tables.length ? { v: 1, tables } : null;
}

export function grantSetToDraft(grants: GrantSet): GrantDraft {
  return new Map(grants.tables.map((table) => [table.db, new Set<GrantOp>(table.ops)]));
}

export type ChannelRowAction =
  | "copy"
  | "open"
  | "revoke" // synced channel revoke (desired-state)
  | "stopPublic" // public channel teardown
  | "recreate" // expired link → open the link form pre-filled
  | "copyShare" // legacy share row copy (s3: re-presign only)
  | "renewLink" // s3: extend the link, content untouched
  | "refreshExport" // s3: re-export current data + renew (danger)
  | "revokeShare"; // legacy share row revoke

export interface ChannelRowView {
  key: string;
  icon: "globe" | "lock";
  badge: string;
  badgeTone: "pub" | "plain";
  /** Address (or its stand-in) — the row headline. */
  title: string;
  metaLine: string;
  /** Recovery/attention line under the meta, when something needs saying. */
  warnLine?: string;
  url: string | null;
  actions: ChannelRowAction[];
}

const expiryText = (expiresAt: number | null | undefined): string =>
  expiresAt ? `至 ${new Date(expiresAt).toLocaleString()}` : "永久";

/** Row view for a derived site channel (public or synced link). */
export function channelRowView(
  c: SiteChannel,
  opts: { edge: EdgeStatus | null; now?: number } = { edge: null },
): ChannelRowView {
  const revoked = c.desiredState === "revoked";
  const isPublic = c.audience === "anyone";
  const meta: string[] = [CHANNEL_STATUS_LABEL[c.status]];
  if (c.status === "unverified") meta.push("本设备未记录已验证入口");
  if (!isPublic) {
    meta.push(c.permission === "edit" ? "可编辑" : "只读");
    if (c.hasPassword) meta.push("🔒 有口令");
    meta.push(expiryText(c.expiresAt));
  }
  if (c.hosting === "room") {
    // Availability and freshness are DIFFERENT facts: the room stays reachable
    // while the controller sleeps, but its content is frozen at the last sync.
    const room = opts.edge?.rooms.find((r) => r.slug === c.slug);
    meta.push("Edge 托管 · 设备离线仍可访问");
    meta.push(
      room?.lastSuccessAt != null
        ? `内容同步于 ${timeAgo(room.lastSuccessAt)}`
        : "等待首次同步",
    );
  }
  let warnLine: string | undefined;
  if (revoked && (c.status === "waiting_controller" || c.status === "cleanup_pending"))
    warnLine = "撤销已请求，等待控制设备上线完成清理";
  else if (revoked) warnLine = "已提交撤销";
  else if (c.status === "expired")
    warnLine = "链接已过期 — 过期链接无法访问，可重新创建";

  const actions: ChannelRowAction[] = [];
  if (!revoked) {
    if (c.status === "expired") {
      actions.push("recreate", "revoke");
    } else {
      // A capability URL grants access; an expired one must not be copyable.
      if (c.url) actions.push("copy", "open");
      actions.push(isPublic ? "stopPublic" : "revoke");
    }
  }
  return {
    key: c.id ?? c.slug ?? c.url ?? "unverified",
    icon: isPublic ? "globe" : "lock",
    badge: isPublic ? "公开" : c.hosting === "room" ? "Edge 链接" : "设备链接",
    badgeTone: isPublic ? "pub" : "plain",
    title: c.url ?? (isPublic ? "任何人可访问" : "等待生成地址"),
    metaLine: meta.join(" · "),
    warnLine,
    url: c.status === "expired" ? null : c.url,
    actions,
  };
}

/** Row view for a legacy (node-local / aggregated / bucket) share row. */
export function legacyShareRowView(s: ShareListItem, now = Date.now()): ChannelRowView {
  const s3 = s.transport === "s3";
  const expired = s.expiresAt != null && now >= s.expiresAt;
  const meta: string[] = [];
  if (s.lifecycle === "cleanup_pending") meta.push("撤销待确认");
  else if (s.lifecycle === "provisioning") meta.push("正在创建");
  else meta.push(s.permission === "edit" ? "可编辑" : "只读");
  if (s.hasPassword) meta.push("🔒 有口令");
  if (s3) {
    // A bucket share is a SNAPSHOT: content age and link validity are separate.
    if (s.contentUpdatedAt) meta.push(`内容生成于 ${new Date(s.contentUpdatedAt).toLocaleString()}`);
    meta.push(s.expiresAt ? `链接有效${expiryText(s.expiresAt)}` : "链接已失效");
  } else {
    meta.push(expiryText(s.expiresAt));
  }
  const actions: ChannelRowAction[] = [];
  let warnLine: string | undefined;
  if (s.lifecycle === "cleanup_pending") {
    warnLine = "撤销已请求，等待 Edge 确认销毁";
    actions.push("revokeShare");
  } else if (expired && !s3) {
    warnLine = "链接已过期 — 过期链接无法访问，可重新创建";
    actions.push("recreate", "revokeShare");
  } else if (s3) {
    actions.push("copyShare", "renewLink", "refreshExport", "revokeShare");
  } else {
    actions.push("copyShare");
    if (s.url) actions.push("open");
    actions.push("revokeShare");
  }
  return {
    key: s.slug,
    icon: "lock",
    badge: s.hosting === "room" ? "Edge 链接" : s3 ? "快照链接" : "设备链接",
    badgeTone: "plain",
    title: s.source,
    metaLine: meta.join(" · "),
    warnLine,
    url: expired ? null : (s.url ?? null),
    actions,
  };
}

// ── hosting derivation ────────────────────────────────────────────────────────

export type DeviceOptionState = "ok" | "never_synced" | "error" | "disabled";

/** Whether a paired device can be an automatic publish target right now.
 *  Unsyncable devices stay VISIBLE in pickers (greyed, with a way out) —
 *  hiding them made freshly-paired devices "disappear". */
export function deviceOptionState(t: Scope): DeviceOptionState {
  if (t.id === "server") return "ok"; // the current host — no availability row
  if (!t.availability?.enabled) return "disabled";
  if (t.availability.lastStatus === "error") return "error";
  if (t.availability.lastSuccessAt == null) return "never_synced";
  return "ok";
}

export const DEVICE_OPTION_SUFFIX: Record<DeviceOptionState, string> = {
  ok: "",
  never_synced: "（等待首次同步）",
  error: "（同步失败）",
  disabled: "（已停用）",
};

export interface HostingPlanInput {
  access: "link" | "public";
  /** true = mechanism derived from the audience; false = user override. */
  hostingAuto: boolean;
  hosting: "device" | "edge";
  selId: string;
  targets: Scope[];
  noOrigin: boolean;
  edge: Pick<EdgeStatus, "configured" | "capabilities"> | null;
  /** This host has a configured public/LAN entry (siteHosting.publicBaseUrl). */
  serverEntryOk: boolean;
}

export interface HostingPlan {
  /** Every paired device target (greyed states included — see deviceOptionState). */
  allDeviceTargets: Scope[];
  /** Targets healthy enough for AUTO selection. */
  usableDeviceTargets: Scope[];
  effHosting: "device" | "edge";
  effSel: Scope | undefined;
  edgeUsable: boolean;
  deviceBlocked: string;
  edgeBlocked: string;
  blocked: string;
  /** Blocked specifically because paired devices exist but none has synced —
   *  the UI offers "立即同步" on these. */
  wantsSyncNow: boolean;
}

/** The audience is the user's decision; the mechanism is derived. Extracted
 *  verbatim from the old inline derivation so it is testable. */
export function hostingPlan(input: HostingPlanInput): HostingPlan {
  const allDeviceTargets = input.targets.filter(
    (t) => t.kind === "server" && (!input.noOrigin || t.id !== "server"),
  );
  const usableDeviceTargets = allDeviceTargets.filter((t) => deviceOptionState(t) === "ok");
  const sel =
    input.targets.find((t) => t.id === input.selId) ??
    usableDeviceTargets[0] ??
    input.targets[0];
  const edgeUsable = !!input.edge?.configured && !!input.edge.capabilities?.includes("room");
  const autoDevice = input.serverEntryOk
    ? (input.targets.find((t) => t.id === "server") ?? usableDeviceTargets[0])
    : (usableDeviceTargets.find((t) => t.id !== "server") ?? usableDeviceTargets[0]);
  const deviceUsable =
    !input.noOrigin && !!autoDevice && (autoDevice.id !== "server" || input.serverEntryOk);
  // Edge Room URLs are unguessable capability links, not a token-free public
  // namespace — "任何人" always publishes to a verified device.
  const autoHosting: "device" | "edge" =
    input.access === "public" ? "device" : edgeUsable ? "edge" : deviceUsable ? "device" : "edge";
  const effHosting =
    input.access === "public" ? "device" : input.hostingAuto ? autoHosting : input.hosting;
  const effSel =
    input.hostingAuto && effHosting === "device" ? (autoDevice ?? sel) : sel;

  const someWaiting =
    allDeviceTargets.length > 0 &&
    usableDeviceTargets.length === 0;
  const deviceBlocked =
    effHosting !== "device"
      ? ""
      : input.noOrigin
        ? input.access === "public"
          ? "此设备通过同步存储桶交换数据、不常驻在线。请在在线主节点管理公开发布；这里仍可创建由 Edge 托管的私密分享链接。"
          : "此设备通过同步存储桶交换数据、不常驻在线，无法直接托管站点。"
        : usableDeviceTargets.length === 0
          ? someWaiting
            ? "已配对的托管设备当前未确认可用。请先同步成功，或配置当前主节点的访问入口。"
            : "没有可托管站点的设备。"
          : effSel?.id === "server" && !input.serverEntryOk
            ? "当前设备还没有配置公网或局域网入口，访客将无法访问。"
            : "";
  const edgeBlocked =
    input.access === "public" || effHosting !== "edge"
      ? ""
      : input.edge === null
        ? "" // status still loading — don't flash a warning
        : !input.edge.configured
          ? "还没有连接 Edge。部署到你自己的 Cloudflare 后，站点始终在线，你的设备关机也能访问。"
          : !input.edge.capabilities?.includes("room")
            ? "当前 Edge 端点仅支持数据收件（inbox），不能托管站点；重新部署官方 Edge Worker 即可启用。"
            : "";
  return {
    allDeviceTargets,
    usableDeviceTargets,
    effHosting,
    effSel,
    edgeUsable,
    deviceBlocked,
    edgeBlocked,
    blocked: deviceBlocked || edgeBlocked,
    wantsSyncNow: effHosting === "device" && !input.noOrigin && someWaiting,
  };
}
