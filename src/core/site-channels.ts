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
  /** Present for v2 synced desired-state channels. */
  id?: string;
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
    | "waiting_controller" // desired revoke synced; secret-owning node is offline
    | "error"
    | "expired"; // share past its expiry (row still manageable)
  /** Human label of where it's served (device label / Edge Room / base URL). */
  source: string;
  slug?: string;
  permission?: "view" | "edit";
  hasPassword?: boolean;
  expiresAt?: number | null;
  desiredState?: "active" | "revoked";
  controllerNodeId?: string;
}

/** Precedence-ordered one-word summary for cards/lists. Attention states first
 *  (something needs the user), then live states, then quiescent ones. */
export type SiteState =
  | "rollback_pending"
  | "cleanup_pending"
  | "error"
  | "provisioning"
  | "room_live"
  | "device_live"
  | "device_syncing"
  | "public_unverified"
  | "link_only"
  | "expired_link" // only expired (still manageable/renewable) links remain
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
  /** Synced v2 desired channels + this node's optional observation. */
  storedChannels?: {
    id: string;
    audience: "public" | "link";
    hosting: "device" | "edge";
    controllerNodeId: string;
    targetRef: string;
    canonicalUrl: string | null;
    policyJson: string | null;
    desiredState: "active" | "revoked";
    status:
      | "provisioning"
      | "syncing"
      | "ready"
      | "rollback_pending"
      | "cleanup_pending"
      | "error"
      | "legacy_unverified"
      | "revoked"
      | "waiting_controller"
      | "unverified";
    lastError?: string | null;
  }[];
  now?: number;
}

/** Fold the scattered stores into the ordered channel list: public entries
 *  first, then rooms, then plain links. */
export function siteChannels(input: SiteChannelInput): SiteChannel[] {
  const now = input.now ?? Date.now();
  const isPublic = input.visibility === "public";
  const out: SiteChannel[] = [];
  const stored = input.storedChannels ?? [];
  const storedPublic = stored.filter((channel) => channel.audience === "public");
  const storedLinkRefs = new Set(
    stored
      .filter((channel) => channel.audience === "link")
      .map((channel) => channel.targetRef),
  );

  for (const channel of stored) {
    // Fully-applied revoked rows remain in CRDT history but are no longer an
    // access channel. Pending/error rows stay visible until cleanup is proven.
    if (channel.desiredState === "revoked" && channel.status === "revoked")
      continue;
    let rawPolicy: Record<string, unknown> = {};
    try {
      const parsed = channel.policyJson
        ? JSON.parse(channel.policyJson)
        : {};
      rawPolicy =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
    } catch {
      // Policy is synced/untrusted; malformed means no optional claims.
    }
    const permission =
      rawPolicy.permission === "view" || rawPolicy.permission === "edit"
        ? rawPolicy.permission
        : undefined;
    const hasPassword =
      typeof rawPolicy.hasPassword === "boolean"
        ? rawPolicy.hasPassword
        : undefined;
    const expiresAt =
      rawPolicy.expiresAt === null ||
      (typeof rawPolicy.expiresAt === "number" &&
        Number.isFinite(rawPolicy.expiresAt))
        ? rawPolicy.expiresAt
        : undefined;
    const status: SiteChannel["status"] =
      channel.desiredState === "active" &&
      expiresAt != null &&
      expiresAt <= now
        ? "expired"
        : channel.status === "legacy_unverified" ||
            channel.status === "unverified"
          ? "unverified"
          : channel.status === "revoked"
            ? "cleanup_pending"
            : channel.status;
    out.push({
      id: channel.id,
      audience: channel.audience === "public" ? "anyone" : "link",
      hosting: channel.hosting === "edge" ? "room" : "device",
      url: channel.canonicalUrl,
      status,
      source: channel.targetRef,
      slug: channel.audience === "link" ? channel.targetRef : undefined,
      permission,
      hasPassword,
      expiresAt,
      desiredState: channel.desiredState,
      controllerNodeId: channel.controllerNodeId,
    });
  }

  for (const r of input.pendingRollbacks)
    out.push({
      audience: "anyone",
      hosting: "device",
      url: r.targetUrl,
      status: "rollback_pending",
      source: r.peerUrl,
    });

  if (isPublic && storedPublic.length === 0) {
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

  const links = input.shares
    .filter((share) => !storedLinkRefs.has(share.slug))
    .map((s) => shareChannel(s, now));
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
  if (has("waiting_controller")) return "cleanup_pending";
  if (has("error")) return "error";
  if (has("provisioning")) return "provisioning";
  const live = channels.filter((c) => c.status === "ready" || c.status === "syncing");
  if (live.some((c) => c.hosting === "room")) return "room_live";
  const pub = channels.filter(
    (c) => c.audience === "anyone" && c.desiredState !== "revoked",
  );
  if (pub.length > 0 || input.visibility === "public") {
    if (pub.some((c) => c.status === "ready")) return "device_live";
    if (pub.some((c) => c.status === "syncing")) return "device_syncing";
    return "public_unverified";
  }
  if (live.length > 0) return "link_only";
  // Expired ≠ gone: the status contract says the row stays manageable, so the
  // card must not collapse it into "private" (users could never find the link
  // they might want to renew).
  if (channels.some((c) => c.status === "expired" && c.desiredState !== "revoked"))
    return "expired_link";
  return "private";
}
