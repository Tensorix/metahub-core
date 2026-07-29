// The single place UI copy for site reachability lives. Derivation (channel
// list + precedence) is core's site-channels module; this maps its states to
// the words users see, so cards, the peek drawer, and the publish dialog can
// never drift apart.

import {
  siteChannels,
  siteState,
  type SiteChannel,
  type SiteChannelInput,
  type SiteState,
} from "../core/site-channels.ts";
import type {
  Site,
  ShareListItem,
  SiteHostingInfo,
} from "./api.ts";

export { siteChannels, siteState };
export type { SiteChannel, SiteChannelInput, SiteState };

/** One-line answer to "who can reach this site right now" (card subtitle). */
export const SITE_STATE_LABEL: Record<SiteState, string> = {
  rollback_pending: "回滚待确认",
  cleanup_pending: "撤销待确认",
  error: "发布失败",
  provisioning: "正在创建 Edge 渠道",
  room_live: "已上线 · Edge 始终在线",
  device_live: "已上线 · 设备托管",
  device_syncing: "正在同步 · 设备托管",
  public_unverified: "已设公开 · 入口未验证",
  link_only: "链接分享中",
  private: "仅本机预览",
};

export const CHANNEL_STATUS_LABEL: Record<SiteChannel["status"], string> = {
  ready: "在线",
  syncing: "同步中",
  unverified: "入口未验证",
  provisioning: "正在创建",
  rollback_pending: "回滚待确认",
  cleanup_pending: "撤销待确认",
  waiting_controller: "等待控制设备",
  error: "失败",
  expired: "已过期",
};

export const channelAudienceLabel = (c: SiteChannel): string =>
  c.audience === "anyone" ? "任何人" : "持链接者";

export const channelHostingLabel = (c: SiteChannel): string =>
  c.hosting === "room" ? "Edge" : "设备";

/** Assemble the core derivation input from the data the panes already hold
 *  (aggregated shares, this node's hosting info — null in replica mode). */
export function siteChannelInput(
  site: Pick<Site, "id" | "visibility">,
  shares: ShareListItem[],
  hosting: SiteHostingInfo | null,
): SiteChannelInput {
  return {
    visibility: site.visibility ?? null,
    publishStates:
      hosting?.publishedSites
        .filter((p) => p.siteId === site.id)
        .map((p) => ({ targetBase: p.targetBase, url: p.url, status: p.status })) ?? [],
    pendingRollbacks:
      hosting?.pendingRollbacks
        .filter((r) => r.siteId === site.id)
        .map((r) => ({ peerUrl: r.peerUrl, targetUrl: r.targetUrl, lastError: r.lastError })) ?? [],
    shares: shares.filter((s) => s.target_id === site.id && s.kind === "site"),
    storedChannels:
      hosting?.channels
        .filter((channel) => channel.siteId === site.id)
        .map((channel) => ({
          id: channel.id,
          audience: channel.audience,
          hosting: channel.hosting,
          controllerNodeId: channel.controllerNodeId,
          targetRef: channel.targetRef,
          canonicalUrl: channel.canonicalUrl,
          policyJson: channel.policyJson,
          desiredState: channel.desiredState,
          status: channel.status,
          lastError: channel.lastError,
        })) ?? [],
  };
}
