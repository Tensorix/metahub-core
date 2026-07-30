// The single request-side revocation state machine for site channels, shared
// by the HTTP route and the replica worker (previously two divergent copies —
// the worker was missing the observation branches entirely). Given who WE are
// relative to the channel, one of three things is true:
//   - we are the serving device      → serving stops right here: observation
//                                      "revoked" is honest immediately;
//   - we control the secret          → the caller must run the (async)
//                                      reconciler to perform teardown;
//   - someone else controls it       → all we can do is sync the desire and
//                                      say so: observation "cleanup_pending".
// The APPLY side (executing teardown from a synced desire) stays in
// sync/site-channel-reconcile.ts — different job, deliberately not merged.

import type { DbDriver } from "./driver.ts";
import { getNodeId } from "./node.ts";
import { updateSite } from "./sites-core.ts";
import {
  listSiteChannelRows,
  putSiteChannelObservation,
  setSiteChannelDesiredState,
  type SiteChannelRow,
} from "./site-channel-store.ts";

export interface RevocationRequest {
  channel: SiteChannelRow;
  /** True when this node owns the secret — the caller must await the
   *  reconciler (async, so it cannot run inside this synchronous mutator). */
  needsReconcile: boolean;
}

export function requestChannelRevocation(db: DbDriver, id: string): RevocationRequest {
  const self = getNodeId(db);
  const channel = setSiteChannelDesiredState(db, id, "revoked");
  if (
    channel.audience === "public" &&
    !listSiteChannelRows(db, channel.site_id).some(
      (item) => item.audience === "public" && item.desired_state === "active",
    )
  ) {
    // Dual-write the legacy register until every client is channel-aware.
    // Otherwise an older synced node could keep serving after the final v2
    // public channel was revoked.
    updateSite(db, channel.site_id, { visibility: "private" });
  }
  if (channel.hosting === "device" && channel.target_ref === self) {
    putSiteChannelObservation(db, {
      channelId: channel.id,
      status: "revoked",
      lastVerifiedAt: Date.now(),
    });
    return { channel, needsReconcile: false };
  }
  if (channel.controller_node_id === self) return { channel, needsReconcile: true };
  putSiteChannelObservation(db, {
    channelId: channel.id,
    status: "cleanup_pending",
    lastError: "等待控制设备上线并应用撤销",
  });
  return { channel, needsReconcile: false };
}
