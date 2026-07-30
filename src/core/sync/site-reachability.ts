// Convenience wrapper over site-channels for callers holding a db handle (CLI,
// server routes): gathers this node's stores and returns the derived view.
// Peer-aggregated shares are the caller's to merge (listSharesAggregated) —
// this stays local/offline-safe.

import type { DbDriver } from "../driver.ts";
import { getSite } from "../sites-core.ts";
import { MhError } from "../errors.ts";
import {
  siteChannels,
  siteState,
  type SiteChannel,
  type SiteChannelInput,
  type SiteState,
} from "../site-channels.ts";
import { listServerSharesLocal } from "./share-actions.ts";
import {
  listPendingSiteRollbacks,
  listSitePublishStates,
} from "./site-publish-recovery.ts";
import {
  listSiteChannelViews,
  sitePublicAccessState,
  type SitePublicAccessState,
} from "../site-channel-store.ts";

export interface SiteReachability {
  siteId: string;
  visibility: "public" | "private";
  state: SiteState;
  channels: SiteChannel[];
  /** Unified public-access decision (serve/config/anomaly) for this node. */
  publicAccess: SitePublicAccessState;
}

export function siteReachability(db: DbDriver, siteId: string): SiteReachability {
  const site = getSite(db, siteId);
  if (!site) throw new MhError("not_found", `no such site: ${siteId}`);
  const input: SiteChannelInput = {
    visibility: site.visibility,
    publishStates: listSitePublishStates(db).filter((s) => s.siteId === siteId),
    pendingRollbacks: listPendingSiteRollbacks(db).filter((r) => r.siteId === siteId),
    shares: listServerSharesLocal(db, siteId).filter((s) => s.kind === "site"),
    storedChannels: listSiteChannelViews(db, siteId),
  };
  const publicAccess = sitePublicAccessState(db, site);
  return {
    siteId,
    visibility: publicAccess.configured ? "public" : "private",
    state: siteState(input),
    channels: siteChannels(input),
    publicAccess,
  };
}
