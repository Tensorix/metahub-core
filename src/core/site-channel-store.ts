import type { DbDriver } from "./driver.ts";
import { emit, grouped, withChangeGroup } from "./crdt.ts";
import { MhError } from "./errors.ts";
import { newId } from "./ids.ts";
import { getNodeId } from "./node.ts";
import {
  deleteSite,
  getSite,
  isSitePublic,
  updateSite,
  type SiteRow,
} from "./sites-core.ts";
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
  // One channel = several LWW columns; a mid-write failure must not leave a
  // half-written row behind (grouped() only labels, it does not roll back).
  // Unchanged columns are NOT re-emitted: a same-values republish would
  // otherwise add 7 oplog rows per call AND re-stamp every column with a fresh
  // HLC — clobbering not-yet-ingested remote edits with stale local values.
  // (Skip-unchanged shrinks that clobber window to the columns actually being
  // changed; true fix would be compare-HLC-and-swap, out of scope here.)
  const desired: Record<string, string | number | null> = {
    audience: input.audience,
    hosting: input.hosting,
    controller_node_id: controller,
    target_ref: input.targetRef,
    canonical_url: input.canonicalUrl ?? null,
    policy_json: input.policy == null ? null : JSON.stringify(input.policy),
    desired_state: input.desiredState ?? "active",
  };
  db.transaction(() => {
    if (!existing) {
      const first = emit(db, "site_channels", id, "site_id", input.siteId);
      emit(db, "site_channels", id, "created_hlc", first.hlc);
    }
    for (const [col, value] of Object.entries(desired)) {
      if (existing && (existing as unknown as Record<string, unknown>)[col] === value) continue;
      emit(db, "site_channels", id, col, value);
    }
  })();
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

export interface ApplySiteUpdateOpts {
  name?: string;
  title?: string;
  visibility?: "public" | "private";
  spa?: boolean;
}

/** All-or-nothing site update, shared by HTTP route, CLI and replica worker.
 * Order inside ONE SQL transaction + change group: ① updateSite (all
 * validation — not_found, duplicate rename, bad enum) ② visibility side
 * effects ③ canonical-URL refresh on rename. A validation failure therefore
 * rolls back completely: a replica must never sync out a revocation for an
 * update the user was told did not happen. The legacy register never stores
 * "public" (v2 channels are the authority); callers pass `recordPublic` to
 * mint the explicit channel for their surface. */
export function applySiteUpdate(
  db: DbDriver,
  siteId: string,
  opts: ApplySiteUpdateOpts,
  hooks?: { recordPublic?: (site: SiteRow) => void },
): SiteRow {
  return db.transaction(() =>
    withChangeGroup("site.update", () => {
      const updated = updateSite(db, siteId, {
        ...opts,
        visibility: opts.visibility === "public" ? "private" : opts.visibility,
      });
      if (opts.visibility === "private") revokePublicSiteChannels(db, siteId);
      if (opts.visibility === "public") hooks?.recordPublic?.(updated);
      if (opts.name !== undefined)
        updatePublicSiteChannelUrls(db, siteId, updated.name);
      return getSite(db, siteId)!;
    }),
  )();
}

/** All-or-nothing site delete: tombstone + channel revocations commit
 * together, and a missing site revokes nothing. Callers run the (async)
 * reconciler AFTER this returns — never inside the transaction. */
export function applySiteDelete(db: DbDriver, siteId: string): boolean {
  return db.transaction(() =>
    withChangeGroup("site.delete", () => {
      if (!deleteSite(db, siteId)) return false;
      revokeAllSiteChannels(db, siteId);
      return true;
    }),
  )();
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

/** Drop a node-local observation (e.g. once a missing share row reappears).
 * Observations are not synced, so this is a plain DELETE with no CRDT echo. */
export function clearSiteChannelObservation(db: DbDriver, channelId: string): void {
  db.query("DELETE FROM site_channel_observations WHERE channel_id = ?").run(channelId);
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

export interface SitePublicAccessState {
  /** Serve-path decision: this node may serve the site token-free right now. */
  serving: boolean;
  /** Management decision: public access is configured (on any node). */
  configured: boolean;
  /** Public rows exist but at least one is malformed. Serving fails closed on
   * such rows; management surfaces must show the anomaly instead of a healthy
   * "public". */
  anomaly: "malformed_public_channel" | null;
}

/** The single public-access decision for every surface (serve routes, CLI,
 * WebUI, grants). A site migrates from the legacy `visibility` register to v2
 * channel semantics when its FIRST `audience='public'` row appears — even a
 * malformed one, which then fails closed. Link rows, revoked links, and
 * unknown-audience rows never flip the public decision, so creating a private
 * share link cannot un-publish a legacy-public site. */
export function sitePublicAccessState(
  db: DbDriver,
  site: Pick<SiteRow, "id" | "visibility">,
): SitePublicAccessState {
  const rawPublic = db
    .query(
      `SELECT ${SELECT} FROM site_channels
       WHERE site_id = ? AND audience = 'public' AND __deleted = 0 ORDER BY created_hlc, id`,
    )
    .all(site.id) as SiteChannelRow[];
  if (rawPublic.length === 0) {
    const legacy = isSitePublic(site);
    return { serving: legacy, configured: legacy, anomaly: null };
  }
  const valid = rawPublic.filter(validRow);
  const active = valid.filter((channel) => channel.desired_state === "active");
  const self = getNodeId(db);
  return {
    serving: active.some(
      (channel) => channel.hosting === "device" && channel.target_ref === self,
    ),
    configured: active.length > 0,
    anomaly: rawPublic.length > valid.length ? "malformed_public_channel" : null,
  };
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
