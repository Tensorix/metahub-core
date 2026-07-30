import type { DbDriver } from "../driver.ts";
import { getNodeId } from "../node.ts";
import {
  clearSiteChannelObservation,
  getSiteChannelObservation,
  getSiteChannelRow,
  listSiteChannelRows,
  putSiteChannelObservation,
  setSiteChannelDesiredState,
} from "../site-channel-store.ts";
import { deleteShare, getShare } from "../shares.ts";
import { siteLifecycle } from "../sites-core.ts";

/** Prefix marking an observation written because the controller's node-local
 * share row (the capability secret) is missing. The reconciler clears it once
 * the row reappears; surfaces show the channel as errored, never as revoked. */
export const CONTROLLER_STATE_MISSING = "controller_state_missing";

/** Apply synced desired-state changes whose node-local secret is owned here.
 * Other devices may revoke an Edge link without receiving the account token:
 * they sync desired_state=revoked; the controller performs teardown when it
 * next comes online and records a local observation.
 *
 * Revocations are emitted on POSITIVE evidence only:
 * - a replicated site tombstone (older clients delete sites without knowing
 *   about channels) revokes the orphaned channels;
 * - an ABSENT site row means "not replicated here yet" and is left untouched;
 * - a missing node-local share row is an error observation, not a revocation;
 * - share expiry never revokes or deletes — serving refuses expired links,
 *   but the share stays manageable (renewable) per the status contract.
 * The "revoked" observation likewise requires teardown evidence: an absent
 * Room record is cleanup_pending, never a fabricated destroy confirmation. */
/** Reconcile without ever throwing: channel maintenance is LOCAL housekeeping
 * and must not turn an otherwise-successful data sync (or an already-committed
 * delete) into a reported failure. Returns the error message for callers that
 * surface warnings, null on success. */
export async function reconcileSiteChannelsQuietly(db: DbDriver): Promise<string | null> {
  try {
    await reconcileSiteChannels(db);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`site channel reconcile failed: ${message}`);
    return message;
  }
}

export async function reconcileSiteChannels(db: DbDriver): Promise<void> {
  const self = getNodeId(db);
  const rows = listSiteChannelRows(db);
  const touched = new Set<string>();
  for (const channel of rows) {
    if (channel.desired_state !== "active") continue;
    if (siteLifecycle(db, channel.site_id) === "tombstoned") {
      setSiteChannelDesiredState(db, channel.id, "revoked");
      touched.add(channel.id);
      continue;
    }
    if (channel.audience !== "link" || channel.controller_node_id !== self) continue;
    if (!getShare(db, channel.target_ref)) {
      putSiteChannelObservation(db, {
        channelId: channel.id,
        status: "error",
        lastError: `${CONTROLLER_STATE_MISSING}: 本机缺少该链接的凭据记录`,
      });
    } else if (
      getSiteChannelObservation(db, channel.id)?.lastError?.startsWith(CONTROLLER_STATE_MISSING)
    ) {
      clearSiteChannelObservation(db, channel.id);
    }
  }
  const pending = rows
    .map((channel) =>
      touched.has(channel.id) ? (getSiteChannelRow(db, channel.id) ?? channel) : channel,
    )
    .filter(
      (channel) =>
        channel.controller_node_id === self &&
        channel.desired_state === "revoked" &&
        channel.audience === "link",
    );
  for (const channel of pending) {
    const share = getShare(db, channel.target_ref);
    try {
      if (channel.hosting === "edge") {
        const { teardownRoomForShare } = await import("./room-peer.ts");
        // target_ref IS the capability slug, so teardown works even when the
        // node-local share row is gone.
        const outcome = await teardownRoomForShare(db, channel.target_ref);
        if (outcome === "cleanup_pending") {
          putSiteChannelObservation(db, {
            channelId: channel.id,
            status: "cleanup_pending",
            lastError: "Edge 尚未确认销毁 Room",
          });
          continue;
        }
        if (outcome === "absent") {
          putSiteChannelObservation(db, {
            channelId: channel.id,
            status: "cleanup_pending",
            lastError: "Edge Room 记录缺失，销毁未确认",
          });
          continue;
        }
      } else if (!share) {
        // Device hosting serves straight from the share row; no row means
        // nothing is served here, which IS the revoked outcome.
        putSiteChannelObservation(db, {
          channelId: channel.id,
          status: "revoked",
          lastVerifiedAt: Date.now(),
        });
        continue;
      }
      if (share) deleteShare(db, share.slug);
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
