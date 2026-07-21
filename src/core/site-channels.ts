// Site reachability — the one derived answer to "who can reach this site right
// now, at which URL, depending on what". A site can be exposed three parallel
// ways (visibility=public at /sites/<name>/, capability share links at
// /share/<slug>, always-on Edge rooms), whose state lives in four scattered
// stores (the synced visibility register, node-local publish states, node-local
// share rows, room peer lifecycles). This module folds them into ONE channel
// list + ONE summary state so every surface (site cards, publish dialog, CLI)
// answers identically instead of re-deriving its own precedence.
//
// PURE + portable (no driver, no node:/bun:): callers hand in the rows they
// already hold. The db-reading convenience wrapper lives in
// sync/site-reachability.ts.

import type { ShareListItem } from "./sync/share-actions.ts";

/** One way the site is (or is about to be) reachable. */
export interface SiteChannel {
  /** anyone = token-free (visibility/public room); link = capability slug. */
  audience: "anyone" | "link";
  /** device = a server node must be online; room = always-on Edge DO. */
  hosting: "device" | "room";
  /** Ready-to-open URL; null when not yet known (e.g. unverified public). */
  url: string | null;
  status:
    | "ready" // serving and verified
    | "syncing" // published, target device not yet confirmed serving
    | "unverified" // visibility=public but no verified entry recorded here
    | "provisioning" // room being created
    | "rollback_pending" // failed publish; compensating write unacknowledged
    | "cleanup_pending" // revoked; Edge has not confirmed room destruction
    | "expired"; // share past its expiry (row still manageable)
  /** Human label of where it's served (device label / Edge Room / base URL). */
  source: string;
  slug?: string;
  permission?: "view" | "edit";
  hasPassword?: boolean;
  expiresAt?: number | null;
}

/** Precedence-ordered one-word summary for cards/lists. Attention states first
 *  (something needs the user), then live states, then quiescent ones. */
export type SiteState =
  | "rollback_pending"
  | "cleanup_pending"
  | "provisioning"
  | "room_live"
  | "device_live"
  | "device_syncing"
  | "public_unverified"
  | "link_only"
  | "private";

export interface SiteChannelInput {
  /** Raw synced register; only exactly "public" counts (core default-deny). */
  visibility: string | null;
  /** Node-local verified publishes of this site (site-publish-recovery). */
  publishStates: { targetBase: string; url: string; status: "ready" | "syncing" }[];
  /** Node-local unacknowledged compensating rollbacks for this site. */
  pendingRollbacks: { peerUrl: string; targetUrl: string; lastError: string }[];
  /** Share listing rows already filtered to this site (local ∪ aggregated). */
  shares: ShareListItem[];
  now?: number;
}

/** Fold the scattered stores into the ordered channel list: public entries
 *  first, then rooms, then plain links. */
export function siteChannels(input: SiteChannelInput): SiteChannel[] {
  const now = input.now ?? Date.now();
  const isPublic = input.visibility === "public";
  const out: SiteChannel[] = [];

  for (const r of input.pendingRollbacks)
    out.push({
      audience: "anyone",
      hosting: "device",
      url: r.targetUrl,
      status: "rollback_pending",
      source: r.peerUrl,
    });

  if (isPublic) {
    for (const p of input.publishStates)
      out.push({
        audience: "anyone",
        hosting: "device",
        url: p.url,
        status: p.status,
        source: p.targetBase,
      });
    // Public with no verified entry recorded on THIS node: either never
    // published to a verified base, or published from another device (publish
    // states are node-local). Surface it honestly instead of guessing.
    if (input.publishStates.length === 0)
      out.push({
        audience: "anyone",
        hosting: "device",
        url: null,
        status: "unverified",
        source: "",
      });
  }

  const links = input.shares.map((s) => shareChannel(s, now));
  // Rooms ahead of plain links: an always-on channel matters more to "where is
  // this reachable" than a device-bound one.
  links.sort((a, b) => Number(b.hosting === "room") - Number(a.hosting === "room"));
  out.push(...links);
  return out;
}

/** Map one aggregated share row to its channel (pure; used for both local and
 *  peer-fetched rows so remote shares merge into the same view). */
export function shareChannel(s: ShareListItem, now = Date.now()): SiteChannel {
  const room = s.hosting === "room";
  const lifecycle = s.lifecycle ?? "active";
  const expired = s.expiresAt != null && s.expiresAt <= now;
  return {
    audience: "link",
    hosting: room ? "room" : "device",
    url: s.url ?? null,
    status:
      lifecycle === "cleanup_pending"
        ? "cleanup_pending"
        : lifecycle === "provisioning"
          ? "provisioning"
          : expired
            ? "expired"
            : "ready",
    source: s.source,
    slug: s.slug,
    permission: s.permission === "edit" ? "edit" : "view",
    hasPassword: s.hasPassword,
    expiresAt: s.expiresAt,
  };
}

/** The single precedence everyone must agree on (cards, dialog, CLI). */
export function siteState(input: SiteChannelInput): SiteState {
  const channels = siteChannels(input);
  const has = (st: SiteChannel["status"]) => channels.some((c) => c.status === st);
  if (has("rollback_pending")) return "rollback_pending";
  if (has("cleanup_pending")) return "cleanup_pending";
  if (has("provisioning")) return "provisioning";
  const live = channels.filter((c) => c.status === "ready" || c.status === "syncing");
  if (live.some((c) => c.hosting === "room")) return "room_live";
  if (input.visibility === "public") {
    const pub = channels.filter((c) => c.audience === "anyone");
    if (pub.some((c) => c.status === "ready")) return "device_live";
    if (pub.some((c) => c.status === "syncing")) return "device_syncing";
    return "public_unverified";
  }
  if (live.length > 0) return "link_only";
  return "private";
}
