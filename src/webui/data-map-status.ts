// The single place UI copy for the workspace data map lives. Derivation (place
// list + precedence) is core's data-map module (served via /api/sync/health or
// the replica's dataMap op); this maps its states to the words users see, so
// the settings sync header and any future badge can never drift apart.

import type { DataMap, DataMapState, DataPlace } from "./api.ts";
import type { DataMapIssue } from "../core/data-map.ts";
import type { ClientMode } from "./data/replica.ts";
import { scopesFor } from "./data/scopes.ts";
import { timeAgo } from "./date.ts";

export type { DataMap, DataMapState, DataPlace };

/** One-line answer to "is my data safe" (settings sync header). */
export function dataMapHeadline(m: DataMap): string {
  const s = m.state;
  switch (s.state) {
    case "no_backup":
      return "数据只在这一处 — 尚未配置任何同步目标";
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

/** Attention states get the warning tint + a way out; healthy stays quiet.
 *  Any peer_error issue is an error even when the headline picked another
 *  state (belt over the core precedence, which already puts errors first). */
export const dataMapTone = (m: DataMap): "ok" | "warn" | "error" =>
  m.state.state === "peer_error" ||
  (m.state.issues ?? []).some((i) => i.kind === "peer_error")
    ? "error"
    : m.state.state === "healthy"
      ? "ok"
      : "warn";

const ISSUE_LABEL: Record<DataMapIssue["kind"], string> = {
  no_backup: "尚未配置任何同步目标",
  peer_error: "同步失败",
  never_synced: "尚未完成首次同步",
  behind: "有改动尚未同步",
  stale: "备份确认已过期",
  pending_blobs: "有附件仅在本机",
};

/** Every concurrent problem as its own display line — the headline picks one
 *  state, these make sure the rest stay visible. */
export function dataMapIssueLines(m: DataMap): string[] {
  return (m.state.issues ?? []).map((i) => {
    const where = i.placeLabel ? `${i.placeLabel}：` : "";
    const detail = i.message ? ` — ${i.message}` : "";
    return `${where}${ISSUE_LABEL[i.kind]}${detail}`;
  });
}

export const PLACE_KIND_LABEL: Record<DataPlace["kind"], string> = {
  self: "本机",
  device: "设备",
  bucket: "存储桶",
};

/** What the data map's `self` place means on THIS surface. The map is computed
 *  by whoever answered /api/sync/health: in window mode that is the SERVER, so
 *  "self" is the workspace primary — calling it 本机 pointed at the wrong
 *  machine. Replica mode computes locally, where 本机 is correct. Copy comes
 *  from scopes.ts COPY (the sanctioned surface vocabulary), never new strings.
 *  TODO(core): a DataPlace.nodeId would let consumers resolve this without
 *  surface inference — needs the peers-routes zod mirror + OpenAPI update. */
export function selfPlaceCopy(mode: ClientMode): {
  kindLabel: string;
  /** Replaces a DEFAULT self label ("本机"); user-named nodes keep their name. */
  labelOverride: string | null;
} {
  if (mode.hold === "replica")
    return { kindLabel: PLACE_KIND_LABEL.self, labelOverride: null };
  const server = scopesFor(mode).find((s) => s.kind === "server");
  return {
    kindLabel: server?.label ?? PLACE_KIND_LABEL.self,
    labelOverride: server?.label ?? null,
  };
}

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
  backend: "工作区同步",
  blob_anchor: "附件长期保存",
  publisher: "发布快照",
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
