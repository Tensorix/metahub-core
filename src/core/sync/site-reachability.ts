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
  isSitePublicConfigured,
  listSiteChannelViews,
} from "../site-channel-store.ts";

export interface SiteReachability {
  siteId: string;
  visibility: "public" | "private";
  state: SiteState;
  channels: SiteChannel[];
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
  return {
    siteId,
    visibility: isSitePublicConfigured(db, site) ? "public" : "private",
    state: siteState(input),
    channels: siteChannels(input),
  };
}
