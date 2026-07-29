// The single place UI copy for the workspace data map lives. Derivation (place
// list + precedence) is core's data-map module (served via /api/sync/health or
// the replica's dataMap op); this maps its states to the words users see, so
// the settings sync header and any future badge can never drift apart.

import type { DataMap, DataMapState, DataPlace } from "./api.ts";
import { timeAgo } from "./date.ts";

export type { DataMap, DataMapState, DataPlace };

/** One-line answer to "is my data safe" (settings sync header). */
export function dataMapHeadline(m: DataMap): string {
  const s = m.state;
  switch (s.state) {
    case "no_backup":
      return "数据只在这一处 — 尚未配置任何同步备份";
    case "pending_blobs":
      return `当前版本已确认保存在 ${s.places} 处 · ${s.pendingBlobCount} 个附件仅在本机`;
    case "unsynced_changes":
      return `当前版本已确认保存在 ${s.places} 处 · 仍有目标尚未同步`;
    case "peer_error":
      return `当前版本已确认保存在 ${s.places} 处 · 有一处同步失败`;
    case "syncing":
      return `当前版本已确认保存在 ${s.places} 处 · 首次同步进行中`;
    case "stale":
      return `当前版本已确认保存在 ${s.places} 处 · 备份确认已过期`;
    case "healthy":
      return `当前版本已确认保存在 ${s.places} 处${s.oldestSyncedAt != null ? ` · 最早确认于${timeAgo(s.oldestSyncedAt)}` : ""}`;
  }
}

/** Attention states get the warning tint + a way out; healthy stays quiet. */
export const dataMapTone = (m: DataMap): "ok" | "warn" | "error" =>
  m.state.state === "healthy"
    ? "ok"
    : m.state.state === "peer_error"
      ? "error"
      : "warn";

export const PLACE_KIND_LABEL: Record<DataPlace["kind"], string> = {
  self: "本机",
  device: "设备",
  bucket: "存储桶",
};

export const PLACE_FRESHNESS_LABEL: Record<DataPlace["freshness"], string> = {
  live: "实时（本机）",
  current: "当前版本已确认",
  behind: "有改动尚未同步",
  stale: "确认已过期",
  error: "同步失败",
  never: "尚未同步",
  disabled: "已停用",
};

export const PLACE_ROLE_LABEL: Record<DataPlace["roles"][number], string> = {
  replica: "完整副本",
  backend: "同步后端",
  blob_anchor: "附件全量库",
  publisher: "本机为其发布快照",
};

/** Per-place caption for the expanded list: freshness + relative time + error. */
export function placeCaption(p: DataPlace): string {
  const parts: string[] = [PLACE_FRESHNESS_LABEL[p.freshness]];
  if (
    (p.freshness === "current" || p.freshness === "stale" || p.freshness === "behind") &&
    p.syncedAt != null
  )
    parts.push(timeAgo(p.syncedAt));
  if (p.lag > 0) parts.push("尚未确认当前版本");
  if (p.error) parts.push(p.error);
  return parts.join(" · ");
}
