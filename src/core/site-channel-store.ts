import type { DbDriver } from "./driver.ts";
import { emit, grouped } from "./crdt.ts";
import { MhError } from "./errors.ts";
import { newId } from "./ids.ts";
import { getNodeId } from "./node.ts";
import { getSite, isSitePublic, type SiteRow } from "./sites-core.ts";
import type { ColumnsOf } from "./sqlcols.ts";

export type SiteChannelAudience = "public" | "link";
export type SiteChannelHosting = "device" | "edge";
export type SiteChannelDesiredState = "active" | "revoked";

export interface SiteChannelRow {
  id: string;
  site_id: string;
  audience: string;
  hosting: string;
  controller_node_id: string;
  target_ref: string;
  canonical_url: string | null;
  policy_json: string | null;
  desired_state: string;
  created_hlc: string;
  __deleted: number;
}

export const SITE_CHANNEL_COLS = [
  "id",
  "site_id",
  "audience",
  "hosting",
  "controller_node_id",
  "target_ref",
  "canonical_url",
  "policy_json",
  "desired_state",
  "created_hlc",
  "__deleted",
] as const;
const _siteChannelCols: ColumnsOf<SiteChannelRow, typeof SITE_CHANNEL_COLS> =
  SITE_CHANNEL_COLS;
const SELECT = SITE_CHANNEL_COLS.join(", ");

export type SiteChannelObservationStatus =
  | "provisioning"
  | "syncing"
  | "ready"
  | "rollback_pending"
  | "cleanup_pending"
  | "error"
  | "legacy_unverified"
  | "revoked";

export interface SiteChannelObservation {
  channelId: string;
  status: SiteChannelObservationStatus;
  lastVerifiedAt: number | null;
  lastError: string | null;
}

export type SiteChannelViewStatus =
  | SiteChannelObservationStatus
  | "waiting_controller"
  | "unverified";

export interface SiteChannelView {
  id: string;
  siteId: string;
  audience: SiteChannelAudience;
  hosting: SiteChannelHosting;
  controllerNodeId: string;
  targetRef: string;
  canonicalUrl: string | null;
  policyJson: string | null;
  desiredState: SiteChannelDesiredState;
  status: SiteChannelViewStatus;
  lastVerifiedAt: number | null;
  lastError: string | null;
}

function validRow(row: SiteChannelRow): boolean {
  return (
    (row.audience === "public" || row.audience === "link") &&
    (row.hosting === "device" || row.hosting === "edge") &&
    (row.desired_state === "active" || row.desired_state === "revoked")
  );
}

export function listSiteChannelRows(
  db: DbDriver,
  siteId?: string,
): SiteChannelRow[] {
  const rows = (
    siteId
      ? db
          .query(
            `SELECT ${SELECT} FROM site_channels
             WHERE site_id = ? AND __deleted = 0 ORDER BY created_hlc, id`,
          )
          .all(siteId)
      : db
          .query(
            `SELECT ${SELECT} FROM site_channels
             WHERE __deleted = 0 ORDER BY created_hlc, id`,
          )
          .all()
  ) as SiteChannelRow[];
  // Synced rows are untrusted input. Invalid enum values default-deny and stay
  // in the table for forward compatibility, but never become active channels.
  return rows.filter(validRow);
}

export function getSiteChannelRow(
  db: DbDriver,
  id: string,
): SiteChannelRow | null {
  const row = db
    .query(`SELECT ${SELECT} FROM site_channels WHERE id = ? AND __deleted = 0`)
    .get(id) as SiteChannelRow | null;
  return row && validRow(row) ? row : null;
}

export interface PutSiteChannelInput {
  id?: string;
  siteId: string;
  audience: SiteChannelAudience;
  hosting: SiteChannelHosting;
  controllerNodeId?: string;
  targetRef: string;
  canonicalUrl?: string | null;
  policy?: unknown;
  desiredState?: SiteChannelDesiredState;
}

/** Upsert one logical channel. Re-publishing to the same audience/host/target
 * reactivates the existing row instead of accumulating duplicates. */
export const putSiteChannel = grouped(function putSiteChannel(
  db: DbDriver,
  input: PutSiteChannelInput,
): SiteChannelRow {
  if (!getSite(db, input.siteId))
    throw new MhError("not_found", `no such site: ${input.siteId}`);
  const controller = input.controllerNodeId ?? getNodeId(db);
  const existing = input.id
    ? getSiteChannelRow(db, input.id)
    : (db
        .query(
          `SELECT ${SELECT} FROM site_channels
           WHERE site_id = ? AND audience = ? AND hosting = ? AND target_ref = ?
             AND __deleted = 0
           ORDER BY created_hlc LIMIT 1`,
        )
        .get(
          input.siteId,
          input.audience,
          input.hosting,
          input.targetRef,
        ) as SiteChannelRow | null);
  const id =
    existing?.id ??
    newId(
      "chan",
      `${input.audience}-${input.hosting}-${input.siteId}`,
      "channel",
    );
  if (!existing) {
    const first = emit(db, "site_channels", id, "site_id", input.siteId);
    emit(db, "site_channels", id, "created_hlc", first.hlc);
  }
  emit(db, "site_channels", id, "audience", input.audience);
  emit(db, "site_channels", id, "hosting", input.hosting);
  emit(db, "site_channels", id, "controller_node_id", controller);
  emit(db, "site_channels", id, "target_ref", input.targetRef);
  emit(db, "site_channels", id, "canonical_url", input.canonicalUrl ?? null);
  emit(
    db,
    "site_channels",
    id,
    "policy_json",
    input.policy == null ? null : JSON.stringify(input.policy),
  );
  emit(
    db,
    "site_channels",
    id,
    "desired_state",
    input.desiredState ?? "active",
  );
  return getSiteChannelRow(db, id)!;
});

export const setSiteChannelDesiredState = grouped(
  function setSiteChannelDesiredState(
    db: DbDriver,
    id: string,
    desired: SiteChannelDesiredState,
  ): SiteChannelRow {
    if (!getSiteChannelRow(db, id))
      throw new MhError("not_found", `no such site channel: ${id}`);
    emit(db, "site_channels", id, "desired_state", desired);
    return getSiteChannelRow(db, id)!;
  },
);

export function revokePublicSiteChannels(
  db: DbDriver,
  siteId: string,
): number {
  const active = listSiteChannelRows(db, siteId).filter(
    (channel) =>
      channel.audience === "public" && channel.desired_state === "active",
  );
  for (const channel of active)
    setSiteChannelDesiredState(db, channel.id, "revoked");
  return active.length;
}

/** Keep the authorization snapshot attached to every live public channel in
 * lockstep with the site's compatibility register. The channel copy is what a
 * v2 target node actually serves, so grant edits must not wait for a republish. */
export function setPublicSiteChannelPolicies(
  db: DbDriver,
  siteId: string,
  policy: unknown,
): number {
  const active = listSiteChannelRows(db, siteId).filter(
    (channel) =>
      channel.audience === "public" && channel.desired_state === "active",
  );
  for (const channel of active) {
    putSiteChannel(db, {
      id: channel.id,
      siteId: channel.site_id,
      audience: "public",
      hosting: channel.hosting as SiteChannelHosting,
      controllerNodeId: channel.controller_node_id,
      targetRef: channel.target_ref,
      canonicalUrl: channel.canonical_url,
      policy,
      desiredState: "active",
    });
  }
  return active.length;
}

function parsedPolicy(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    // Invalid synced policy must remain default-deny, never be re-emitted as a
    // string that a future reader could mistake for a valid policy object.
    return null;
  }
}

/** A public device URL contains the mutable site slug. Keep the canonical
 * address accurate after rename without touching stable capability URLs. */
export function updatePublicSiteChannelUrls(
  db: DbDriver,
  siteId: string,
  siteName: string,
): number {
  const active = listSiteChannelRows(db, siteId).filter(
    (channel) =>
      channel.audience === "public" &&
      channel.hosting === "device" &&
      channel.desired_state === "active" &&
      channel.canonical_url != null,
  );
  let changed = 0;
  for (const channel of active) {
    let canonicalUrl: string;
    try {
      const url = new URL(channel.canonical_url!);
      url.pathname = `/sites/${encodeURIComponent(siteName)}/`;
      url.search = "";
      url.hash = "";
      canonicalUrl = url.toString();
    } catch {
      continue;
    }
    putSiteChannel(db, {
      id: channel.id,
      siteId: channel.site_id,
      audience: "public",
      hosting: "device",
      controllerNodeId: channel.controller_node_id,
      targetRef: channel.target_ref,
      canonicalUrl,
      policy: parsedPolicy(channel.policy_json),
      desiredState: "active",
    });
    changed++;
  }
  return changed;
}

/** Site deletion first requests teardown for every channel. Link controllers
 * can then remove capability state asynchronously after the site row is gone. */
export function revokeAllSiteChannels(db: DbDriver, siteId: string): number {
  const active = listSiteChannelRows(db, siteId).filter(
    (channel) => channel.desired_state === "active",
  );
  for (const channel of active)
    setSiteChannelDesiredState(db, channel.id, "revoked");
  return active.length;
}

export function putSiteChannelObservation(
  db: DbDriver,
  input: {
    channelId: string;
    status: SiteChannelObservationStatus;
    lastVerifiedAt?: number | null;
    lastError?: string | null;
  },
): SiteChannelObservation {
  db.query(
    `INSERT INTO site_channel_observations
       (channel_id,status,last_verified_at,last_error)
     VALUES (?,?,?,?)
     ON CONFLICT(channel_id) DO UPDATE SET
       status=excluded.status,
       last_verified_at=excluded.last_verified_at,
       last_error=excluded.last_error`,
  ).run(
    input.channelId,
    input.status,
    input.lastVerifiedAt ?? null,
    input.lastError ?? null,
  );
  return {
    channelId: input.channelId,
    status: input.status,
    lastVerifiedAt: input.lastVerifiedAt ?? null,
    lastError: input.lastError ?? null,
  };
}

export function getSiteChannelObservation(
  db: DbDriver,
  channelId: string,
): SiteChannelObservation | null {
  const row = db
    .query(
      `SELECT channel_id,status,last_verified_at,last_error
       FROM site_channel_observations WHERE channel_id = ?`,
    )
    .get(channelId) as {
    channel_id: string;
    status: SiteChannelObservationStatus;
    last_verified_at: number | null;
    last_error: string | null;
  } | null;
  return row
    ? {
        channelId: row.channel_id,
        status: row.status,
        lastVerifiedAt: row.last_verified_at,
        lastError: row.last_error,
      }
    : null;
}

export function listSiteChannelViews(
  db: DbDriver,
  siteId?: string,
): SiteChannelView[] {
  const self = getNodeId(db);
  return listSiteChannelRows(db, siteId).map((channel) => {
    const observation = getSiteChannelObservation(db, channel.id);
    let status: SiteChannelViewStatus;
    if (channel.desired_state === "active") {
      status = observation?.status ?? "unverified";
    } else if (
      channel.hosting === "device" &&
      channel.target_ref === self
    ) {
      // This node is the actual public host. Reading the synced revocation is
      // itself sufficient proof that anonymous serving has stopped here.
      status = "revoked";
    } else if (
      observation?.status === "revoked" ||
      observation?.status === "cleanup_pending" ||
      observation?.status === "rollback_pending" ||
      observation?.status === "error"
    ) {
      status = observation.status;
    } else {
      // Never let a stale ready/provisioning observation make a revoked
      // desired state look live.
      status =
        channel.controller_node_id === self
          ? "cleanup_pending"
          : "waiting_controller";
    }
    return {
      id: channel.id,
      siteId: channel.site_id,
      audience: channel.audience as SiteChannelAudience,
      hosting: channel.hosting as SiteChannelHosting,
      controllerNodeId: channel.controller_node_id,
      targetRef: channel.target_ref,
      canonicalUrl: channel.canonical_url,
      policyJson: channel.policy_json,
      desiredState: channel.desired_state as SiteChannelDesiredState,
      status,
      lastVerifiedAt: observation?.lastVerifiedAt ?? null,
      lastError: observation?.lastError ?? null,
    };
  });
}

/** Channel-aware public serve decision. Once any v2 channel exists for a site,
 * legacy visibility is no longer enough: only this node's active public device
 * target may serve token-free. Sites not migrated yet retain legacy behavior. */
export function isSitePublicOnThisNode(
  db: DbDriver,
  site: Pick<SiteRow, "id" | "visibility">,
): boolean {
  const channels = listSiteChannelRows(db, site.id);
  const hasChannelRows = !!db
    .query(
      "SELECT 1 AS ok FROM site_channels WHERE site_id = ? AND __deleted = 0 LIMIT 1",
    )
    .get(site.id);
  // Only a truly unmigrated site may use the legacy register. A malformed or
  // partially-understood v2 row is evidence that channel semantics apply, and
  // therefore fails closed instead of reopening global public access.
  if (!hasChannelRows) return isSitePublic(site);
  const self = getNodeId(db);
  return channels.some(
    (channel) =>
      channel.audience === "public" &&
      channel.hosting === "device" &&
      channel.desired_state === "active" &&
      channel.target_ref === self,
  );
}

/** Logical access state for management surfaces. Legacy rows with no channel
 * keep their global visibility behavior; once channel semantics exist, only an
 * active explicit public channel counts as configured public access. */
export function isSitePublicConfigured(
  db: DbDriver,
  site: Pick<SiteRow, "id" | "visibility">,
): boolean {
  const channels = listSiteChannelRows(db, site.id);
  if (channels.length === 0) return isSitePublic(site);
  return channels.some(
    (channel) =>
      channel.audience === "public" &&
      channel.desired_state === "active",
  );
}

export function publicSiteChannelOnThisNode(
  db: DbDriver,
  siteId: string,
): SiteChannelRow | null {
  const self = getNodeId(db);
  return (
    listSiteChannelRows(db, siteId).find(
      (channel) =>
        channel.audience === "public" &&
        channel.hosting === "device" &&
        channel.desired_state === "active" &&
        channel.target_ref === self,
    ) ?? null
  );
}
