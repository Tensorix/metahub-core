import type { DbDriver } from "../driver.ts";
import { getNodeId } from "../node.ts";
import {
  getSiteChannelRow,
  listSiteChannelRows,
  putSiteChannelObservation,
  setSiteChannelDesiredState,
} from "../site-channel-store.ts";
import { deleteShare, getShare, shareExpired } from "../shares.ts";
import { getSite } from "../sites-core.ts";

/** Apply synced desired-state changes whose node-local secret is owned here.
 * Other devices may revoke an Edge link without receiving the account token:
 * they sync desired_state=revoked; the controller performs teardown when it
 * next comes online and records a local observation. */
export async function reconcileSiteChannels(db: DbDriver): Promise<void> {
  const self = getNodeId(db);
  const rows = listSiteChannelRows(db);
  // Compatibility safety net: older clients can tombstone a site without
  // knowing about channels. The controller turns every orphaned active channel
  // into an explicit synced revocation before cleaning node-local capability
  // state, so an old delete cannot leave an Edge copy live indefinitely.
  for (const channel of rows) {
    const controlledShare =
      channel.audience === "link" &&
      channel.controller_node_id === self
        ? getShare(db, channel.target_ref)
        : null;
    if (
      channel.desired_state === "active" &&
      (
        !getSite(db, channel.site_id) ||
        (
          channel.audience === "link" &&
          channel.controller_node_id === self &&
          (!controlledShare || shareExpired(controlledShare))
        )
      )
    )
      setSiteChannelDesiredState(db, channel.id, "revoked");
  }
  const pending = rows
    .map((channel) => getSiteChannelRow(db, channel.id) ?? channel)
    .filter(
    (channel) =>
      channel.controller_node_id === self &&
      channel.desired_state === "revoked" &&
      channel.audience === "link",
    );
  for (const channel of pending) {
    const share = getShare(db, channel.target_ref);
    if (!share) {
      putSiteChannelObservation(db, {
        channelId: channel.id,
        status: "revoked",
        lastVerifiedAt: Date.now(),
      });
      continue;
    }
    try {
      if (channel.hosting === "edge") {
        const { teardownRoomForShare } = await import("./room-peer.ts");
        const outcome = await teardownRoomForShare(db, share.slug);
        if (outcome === "cleanup_pending") {
          putSiteChannelObservation(db, {
            channelId: channel.id,
            status: "cleanup_pending",
            lastError: "Edge 尚未确认销毁 Room",
          });
          continue;
        }
      }
      deleteShare(db, share.slug);
      putSiteChannelObservation(db, {
        channelId: channel.id,
        status: "revoked",
        lastVerifiedAt: Date.now(),
      });
    } catch (error) {
      putSiteChannelObservation(db, {
        channelId: channel.id,
        status: "cleanup_pending",
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
