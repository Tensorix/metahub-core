// Share orchestration shared by the CLI (`mh share`) and the WebUI (/api/share),
// so both surfaces resolve targets, mint rows / bucket bundles, and aggregate
// listings identically (the addAndSyncStoragePeer pattern).
//
// Two backends, two homes for the record:
//   - server share → a local `shares` row on the serving node (this node, or a
//     paired peer when `server` names one — created there over HTTP with the grant).
//   - object-storage share → objects in the bucket (no local row); listable by any
//     device that holds the bucket. See share-export.ts.
// Cross-device listing is fan-out: local rows + each bucket + each paired peer.

import type { DbDriver } from "../driver.ts";
import { z } from "zod";
import { MhError } from "../errors.ts";
import { randomSuffix } from "../ids.ts";
import { resolveEntity } from "../resolve.ts";
import { resolveSite, getSite } from "../sites.ts";
import { getDocument } from "../documents.ts";
import { getDatabase } from "../databases.ts";
import { listPeers, getPeer } from "./peers.ts";
import {
  createShare,
  deleteShare,
  getShare,
  getShareByRequestId,
  listShares,
  listSharesForTarget,
  hashSharePassword,
  type ShareKind,
  type SharePermission,
} from "../shares.ts";
import {
  createBucketShare,
  renewBucketShare,
  listBucketShares,
  deleteBucketShareObjects,
} from "./share-export.ts";
import { MAX_PRESIGN_SECONDS } from "./storage-s3-bun.ts";
import type { S3Config } from "./storage.ts";
import { edgeCapabilities, getEdgeConfig } from "./edge-config.ts";
import { roomUrlOf } from "./room-url.ts";
import {
  listSiteChannelRows,
  putSiteChannel,
  putSiteChannelObservation,
  setSiteChannelDesiredState,
} from "../site-channel-store.ts";

const DEFAULT_SHARE_VIEWER = "https://share.mh.tensorix.org";
const DEFAULT_S3_EXPIRY_SEC = MAX_PRESIGN_SECONDS;
const PEER_LIST_TIMEOUT_MS = 4000;
const PEER_SHARE_TIMEOUT_MS = 10_000;
const CreatedShareWireSchema = z.object({
  slug: z.string().min(1).max(128),
  kind: z.enum(["doc", "database", "site"]),
  permission: z.enum(["view", "edit"]),
  transport: z.literal("server"),
  hosting: z.enum(["server", "room"]),
  url: z.string().url(),
  expiresAt: z.number().nullable(),
  source: z.string(),
});

export interface CreateShareRequest {
  kind: ShareKind;
  ref: string;
  permission?: SharePermission;
  transport?: "server" | "s3";
  /** Hosting surface for server shares. room provisions an always-on Edge room. */
  hosting?: "server" | "room";
  password?: string | null;
  /** Server: any duration (ms); null = never. s3: clamped to ≤7d; default 7d. */
  expiresMs?: number | null;
  /** server transport target: a paired peer url → create remotely on that peer;
   *  any other base url (this node's origin / LAN / domain) → create locally and
   *  record it as served_base; undefined → local with no recorded base. */
  server?: string | null;
  /** s3: which bucket peer url; default the single s3 peer if exactly one. */
  bucketUrl?: string | null;
  /** s3 only: the static viewer base for the link. */
  viewerBase?: string;
  /** Serialized GrantSet enabling /share/<slug>/api/* (server transport only —
   *  a presigned static export has no API surface). */
  grants?: string | null;
  /** Idempotency key used when a paired node creates the share remotely. */
  requestId?: string | null;
}

export interface CreatedShare {
  slug: string;
  kind: ShareKind;
  permission: SharePermission;
  transport: "server" | "s3";
  hosting: "server" | "room" | "s3";
  /** Full link to copy (server: served_base/share/slug; s3: viewer link). */
  url: string;
  expiresAt: number | null;
  /** Human label of where it's served: a server address or a bucket name. */
  source: string;
}

/** A row in the aggregated share listing (CLI `list` / WebUI panel). */
export interface ShareListItem {
  slug: string;
  kind: string;
  target_id: string;
  /** Human title of the shared object (for the management list). */
  title: string;
  permission: string;
  transport: "server" | "s3";
  source: string;
  sourceKind: "server" | "peer" | "room" | "bucket";
  /** Paired node that owns this share; present only in aggregated listings so
   *  management actions can be routed back to the correct device. */
  sourceUrl?: string;
  /** Where the share is actually served from: this/a server, an always-on DO
   *  room (server share + kind='room' peer), or a bucket export. */
  hosting?: "server" | "room" | "s3";
  expiresAt: number | null;
  hasPassword: boolean;
  /** server: ready-to-copy link; s3: omitted (use renew to mint a fresh one). */
  url?: string;
  lifecycle?: "active" | "provisioning" | "cleanup_pending";
}

function recordSiteLinkChannel(
  db: DbDriver,
  input: {
    siteId: string;
    slug: string;
    hosting: "server" | "room";
    url: string;
    permission: SharePermission;
    hasPassword: boolean;
    expiresAt: number | null;
  },
): void {
  const channel = putSiteChannel(db, {
    siteId: input.siteId,
    audience: "link",
    hosting: input.hosting === "room" ? "edge" : "device",
    targetRef: input.slug,
    canonicalUrl: input.url,
    policy: {
      permission: input.permission,
      hasPassword: input.hasPassword,
      expiresAt: input.expiresAt,
    },
  });
  putSiteChannelObservation(db, {
    channelId: channel.id,
    status: "ready",
    lastVerifiedAt: Date.now(),
  });
}

/** Best-effort human title of a shared target (falls back to the id). */
function targetTitle(db: DbDriver, kind: string, id: string): string {
  try {
    if (kind === "doc") return getDocument(db, id)?.title || id;
    if (kind === "database") return getDatabase(db, id)?.name || id;
    if (kind === "site") {
      const s = getSite(db, id);
      return s?.title || s?.name || id;
    }
  } catch {
    /* ignore — fall through to id */
  }
  return id;
}

function resolveTarget(db: DbDriver, kind: ShareKind, ref: string): { id: string; title: string } {
  if (kind === "site") {
    const s = resolveSite(db, ref);
    return { id: s.id, title: s.name };
  }
  const c = resolveEntity(db, ref, { kind: kind === "database" ? "db" : "doc" });
  return { id: c.id, title: c.label };
}

function s3PeerConfig(db: DbDriver, url: string): { config: S3Config; label: string } {
  const peer = getPeer(db, url);
  if (!peer || peer.kind !== "s3" || !peer.config)
    throw new MhError("not_found", `no such object-storage bucket: ${url}`);
  return { config: JSON.parse(peer.config) as S3Config, label: peer.label ?? url };
}

/** s3 bucket peers (no secrets) for a transport picker. */
export function listShareBuckets(db: DbDriver): { url: string; label: string }[] {
  return listPeers(db)
    .filter((p) => p.kind === "s3")
    .map((p) => ({ url: p.url, label: p.label ?? p.url }));
}

/** Paired HTTP peer servers (a share can be created on / served by them).
 *  Room peers are deliberately excluded: they are Edge destinations, not
 *  devices a user can select as a hosting node. */
export function listShareServers(db: DbDriver): {
  url: string;
  label: string;
  enabled: boolean;
  lastStatus: string | null;
  lastSuccessAt: number | null;
}[] {
  return listPeers(db)
    .filter((p) => p.kind === "http")
    .map((p) => ({
      url: p.url,
      label: p.label ?? p.url,
      enabled: p.enabled === 1,
      lastStatus: p.last_status,
      lastSuccessAt: p.last_success_at,
    }));
}

function pickBucket(db: DbDriver, bucketUrl?: string | null): string {
  if (bucketUrl) return bucketUrl;
  const buckets = listShareBuckets(db);
  if (buckets.length === 0)
    throw new MhError("invalid_input", "no object-storage bucket attached — add one with `mh config peer add --s3`");
  if (buckets.length > 1)
    throw new MhError("invalid_input", `multiple buckets — pass --bucket <url> (one of: ${buckets.map((b) => b.url).join(", ")})`);
  return buckets[0]!.url;
}

function viewerBase(db: DbDriver, override?: string): string {
  if (override) return override.replace(/\/+$/, "");
  const row = db.query("SELECT value FROM meta WHERE key='cfg_share_viewer_url'").get() as
    | { value: string }
    | null;
  return (row?.value || DEFAULT_SHARE_VIEWER).replace(/\/+$/, "");
}

function viewerOriginOf(base: string): string | undefined {
  try {
    return new URL(base).origin;
  } catch {
    return undefined;
  }
}

function bucketLink(base: string, manifestUrl: string, keyB64?: string, saltB64?: string): string {
  const frag = `m=${encodeURIComponent(manifestUrl)}&` + (keyB64 ? `k=${keyB64}` : `s=${saltB64}`);
  return `${base}/#${frag}`;
}

function absoluteShareUrl(url: string, base: string): string {
  try {
    return new URL(url, `${base.replace(/\/+$/, "")}/`).toString();
  } catch {
    return url;
  }
}

/** The legal-combination matrix in ONE place. Every rule names the conflict and
 *  the way out, so surfaces (CLI flags, WebUI selects, remote peers) fail the
 *  same way instead of each scattering its own throws. */
export function assertShareCombo(req: {
  kind: ShareKind;
  transport: "server" | "s3";
  hosting: "server" | "room";
  permission: SharePermission;
  hasGrants: boolean;
}): void {
  const fail = (msg: string): never => {
    throw new MhError("invalid_input", msg);
  };
  if (req.transport === "s3") {
    if (req.hosting === "room")
      fail("Edge room hosting requires the server transport");
    if (req.hasGrants)
      fail("data grants need the server transport — a static object-storage share has no API surface");
    if (req.permission === "edit")
      fail("object-storage shares are read-only — use the server transport to allow editing");
    if (req.kind === "site")
      fail("sites can't be shared via object storage — use the server transport");
  }
  if (req.hosting === "room" && req.kind !== "site")
    fail("Edge rooms currently host site shares only");
}

/** Resolve, validate, and create (server local / server remote / s3 bucket) a share. */
export async function createShareAction(db: DbDriver, req: CreateShareRequest): Promise<CreatedShare> {
  const permission = req.permission ?? "view";
  const transport = req.transport ?? "server";
  const hosting = req.hosting ?? "server";
  assertShareCombo({ kind: req.kind, transport, hosting, permission, hasGrants: !!req.grants });

  // ── object storage ──────────────────────────────────────────────────────────
  if (transport === "s3") {
    const target = resolveTarget(db, req.kind, req.ref);
    const bucketUrl = pickBucket(db, req.bucketUrl);
    const { config, label } = s3PeerConfig(db, bucketUrl);
    const base = viewerBase(db, req.viewerBase);
    const slug = freshSlug(db);
    const out = await createBucketShare(db, {
      slug,
      // assertShareCombo above rejects site+s3, so the cast can't lie
      kind: req.kind as Exclude<ShareKind, "site">,
      targetId: target.id,
      config,
      password: req.password,
      expiresSec: req.expiresMs != null ? Math.floor(req.expiresMs / 1000) : DEFAULT_S3_EXPIRY_SEC,
      viewerOrigin: viewerOriginOf(base),
    });
    return {
      slug,
      kind: req.kind,
      permission: "view",
      transport: "s3",
      hosting: "s3",
      url: bucketLink(base, out.manifestUrl, out.keyB64, out.saltB64),
      expiresAt: out.presignExp,
      source: `桶 ${label}`,
    };
  }

  // ── server: remote (a paired peer) ────────────────────────────────────────────
  const peer = req.server ? getPeer(db, req.server) : null;
  if (req.server && peer && peer.kind !== "s3") {
    const requestId = req.requestId || `share_${randomSuffix(24)}`;
    const headers = {
      "content-type": "application/json",
      ...(peer.token ? { authorization: `Bearer ${peer.token}` } : {}),
    };
    let res: Response | null = null;
    let transportError: string | null = null;
    try {
      res = await fetch(`${req.server.replace(/\/+$/, "")}/api/share`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...req, requestId, server: undefined }),
        signal: AbortSignal.timeout(PEER_SHARE_TIMEOUT_MS),
      });
    } catch (e) {
      transportError = (e as Error).message;
    }
    const raw = res ? await res.json().catch(() => null) : null;
    const detail = raw as { error?: string } | null;
    const remoteError =
      res && !res.ok ? detail?.error || `remote share failed: ${res.status}` : null;
    let parsed = CreatedShareWireSchema.safeParse(res?.ok ? raw : null);
    if (
      parsed.success &&
      (parsed.data.kind !== req.kind ||
        parsed.data.permission !== permission ||
        parsed.data.hosting !== hosting)
    ) {
      parsed = CreatedShareWireSchema.safeParse(null);
    }
    if (!parsed.success) {
      // The POST may have committed before a lost, malformed, or error
      // response. Resolve the idempotency key before giving up so the caller
      // never sees a fabricated URL and the remote row remains manageable.
      const lookup = await fetch(
        `${req.server.replace(/\/+$/, "")}/api/share/request?id=${encodeURIComponent(requestId)}`,
        {
          headers: peer.token ? { authorization: `Bearer ${peer.token}` } : {},
          signal: AbortSignal.timeout(PEER_SHARE_TIMEOUT_MS),
        },
      ).catch(() => null);
      const lookupBody = lookup?.ok ? await lookup.json().catch(() => null) : null;
      parsed = CreatedShareWireSchema.safeParse(lookupBody);
      if (
        parsed.success &&
        (parsed.data.kind !== req.kind ||
          parsed.data.permission !== permission ||
          parsed.data.hosting !== hosting)
      ) {
        parsed = CreatedShareWireSchema.safeParse(null);
      }
    }
    if (!parsed.success) {
      await fetch(
        `${req.server.replace(/\/+$/, "")}/api/share/request?id=${encodeURIComponent(requestId)}`,
        {
          method: "DELETE",
          headers: peer.token ? { authorization: `Bearer ${peer.token}` } : {},
          signal: AbortSignal.timeout(PEER_SHARE_TIMEOUT_MS),
        },
      ).catch(() => null);
      throw new MhError(
        "network",
        transportError
          ? `could not confirm remote share creation: ${transportError}`
          : remoteError
            ? `${remoteError}; request-id recovery failed and compensation was requested`
            : "remote share returned an invalid response and was compensated",
      );
    }
    const data = parsed.data;
    return {
      slug: data.slug,
      kind: req.kind,
      permission,
      transport: "server",
      hosting: data.hosting,
      url: absoluteShareUrl(data.url, req.server),
      expiresAt: data.expiresAt,
      source: peer.label ?? req.server,
    };
  }

  // ── server: local ─────────────────────────────────────────────────────────────
  const target = resolveTarget(db, req.kind, req.ref);
  const existing = req.requestId ? getShareByRequestId(db, req.requestId) : null;
  if (existing) {
    if (existing.kind !== req.kind || existing.target_id !== target.id)
      throw new MhError("conflict", "share request id was already used for another target");
    const roomPeer = getPeer(db, `room://${existing.slug}`);
    const roomCfg =
      roomPeer?.kind === "room" && roomPeer.config
        ? (JSON.parse(roomPeer.config) as {
            base: string;
            slug: string;
            lifecycle?: string;
          })
        : null;
    const activeRoom = roomCfg && (roomCfg.lifecycle ?? "active") === "active";
    if (roomCfg && !activeRoom)
      throw new MhError("conflict", "Edge Room is not active; cleanup or provisioning is still pending");
    if (hosting === "room" && !activeRoom)
      throw new MhError("conflict", "Edge Room creation did not finish; retry with a new request");
    const base = existing.served_base ?? req.server ?? "";
    const created: CreatedShare = {
      slug: existing.slug,
      kind: existing.kind,
      permission: existing.permission,
      transport: "server",
      hosting: activeRoom ? "room" : "server",
      url: activeRoom
        ? roomUrlOf(roomCfg)
        : `${base.replace(/\/+$/, "")}/share/${existing.slug}`,
      expiresAt: existing.expires_at,
      source: activeRoom ? "Edge Room" : base || "本机服务器",
    };
    if (existing.kind === "site")
      recordSiteLinkChannel(db, {
        siteId: existing.target_id,
        slug: existing.slug,
        hosting: activeRoom ? "room" : "server",
        url: created.url,
        permission: existing.permission,
        hasPassword: !!existing.pw_hash,
        expiresAt: existing.expires_at,
      });
    return created;
  }
  // Room preflight BEFORE minting the row — a doomed request must not leave a
  // create-then-delete trace (kind is covered by assertShareCombo above).
  const roomEdge = hosting === "room" ? getEdgeConfig(db) : null;
  if (hosting === "room") {
    if (!roomEdge) throw new MhError("invalid_input", "Edge is not configured");
    if (!edgeCapabilities(roomEdge).includes("room"))
      throw new MhError("conflict", "Configured Edge host supports inbox only, not Room hosting");
  }
  let pwSalt: string | null = null;
  let pwHash: string | null = null;
  if (req.password) {
    const h = await hashSharePassword(req.password);
    pwSalt = h.salt;
    pwHash = h.hash;
  }
  // `server` here is a plain reachable base (not a peer): record it as served_base.
  const servedBase = req.server ? req.server.replace(/\/+$/, "") : null;
  const share = createShare(db, {
    kind: req.kind,
    target_id: target.id,
    permission,
    pwSalt,
    pwHash,
    expiresAt: req.expiresMs != null ? Date.now() + req.expiresMs : null,
    servedBase,
    grants: req.grants ?? null, // validated + canonicalized inside createShare
    requestId: req.requestId ?? null,
  });
  let roomUrl: string | null = null;
  if (hosting === "room") {
    try {
      const { provisionRoomForShare } = await import("./room-peer.ts");
      roomUrl = (await provisionRoomForShare(db, share, roomEdge!)).url;
    } catch (e) {
      const { teardownRoomForShare } = await import("./room-peer.ts");
      const cleanup = await teardownRoomForShare(db, share.slug).catch(
        () => "cleanup_pending" as const,
      );
      if (cleanup !== "cleanup_pending") deleteShare(db, share.slug);
      throw e;
    }
  }
  const created: CreatedShare = {
    slug: share.slug,
    kind: req.kind,
    permission,
    transport: "server",
    hosting,
    url: roomUrl ?? `${servedBase ?? ""}/share/${share.slug}`,
    expiresAt: share.expires_at,
    source: roomUrl ? "Edge Room" : servedBase || "本机服务器",
  };
  if (share.kind === "site")
    recordSiteLinkChannel(db, {
      siteId: share.target_id,
      slug: share.slug,
      hosting,
      url: created.url,
      permission: share.permission,
      hasPassword: !!share.pw_hash,
      expiresAt: share.expires_at,
    });
  return created;
}

/** This node's server-share rows only (sync, no network) — the bucket-free
 *  subset of listSharesLocal. Site reachability and CLI listings use it so a
 *  local derivation never waits on an S3 scan. */
export function listServerSharesLocal(db: DbDriver, targetId?: string): ShareListItem[] {
  const out: ShareListItem[] = [];
  const rows = targetId ? listSharesForTarget(db, targetId) : listShares(db);
  for (const r of rows) {
    // A kind='room' peer bound to the slug marks the share as room-hosted; its
    // always-on link is the room URL (the local /share link keeps working too).
    const roomPeer = getPeer(db, `room://${r.slug}`);
    const roomCfg =
      roomPeer?.kind === "room" && roomPeer.config
        ? (JSON.parse(roomPeer.config) as {
            base?: string;
            slug?: string;
            lifecycle?: "active" | "provisioning" | "cleanup_pending";
          })
        : null;
    const roomUrl =
      roomCfg?.base && roomCfg.slug && (roomCfg.lifecycle ?? "active") === "active"
        ? roomUrlOf({ base: roomCfg.base, slug: roomCfg.slug })
        : null;
    out.push({
      slug: r.slug,
      kind: r.kind,
      target_id: r.target_id,
      title: targetTitle(db, r.kind, r.target_id),
      permission: r.permission,
      transport: "server",
      source: roomCfg
        ? roomCfg.lifecycle === "cleanup_pending"
          ? `Edge Room（撤销待确认）`
          : `房间 ${r.slug}`
        : r.served_base || "本机服务器",
      sourceKind: roomCfg ? "room" : "server",
      hosting: roomUrl ? "room" : "server",
      ...(roomCfg ? { hosting: "room" as const, lifecycle: roomCfg.lifecycle ?? "active" } : {}),
      expiresAt: r.expires_at,
      hasPassword: !!r.pw_hash,
      url: roomCfg
        ? roomUrl ?? undefined
        : r.served_base
          ? `${r.served_base}/share/${r.slug}`
          : `/share/${r.slug}`,
    });
  }
  return out;
}

/** Local listing (server rows + each attached bucket) — NO peer fan-out (so the
 *  /api/shares endpoint a peer calls can't recurse). Optional target filter. */
export async function listSharesLocal(db: DbDriver, targetId?: string): Promise<ShareListItem[]> {
  const out: ShareListItem[] = listServerSharesLocal(db, targetId);
  for (const p of listPeers(db).filter((x) => x.kind === "s3" && x.config)) {
    const config = JSON.parse(p.config!) as S3Config;
    const metas = await listBucketShares(config).catch(() => []);
    for (const m of metas) {
      if (targetId && m.target_id !== targetId) continue;
      out.push({
        slug: m.slug,
        kind: m.kind,
        target_id: m.target_id,
        title: m.title || m.target_id,
        permission: m.permission,
        transport: "s3",
        source: `桶 ${p.label ?? p.url}`,
        sourceKind: "bucket",
        hosting: "s3",
        expiresAt: m.presign_exp,
        hasPassword: m.has_password,
      });
    }
  }
  return out;
}

export function createdShareByRequestId(
  db: DbDriver,
  requestId: string,
): CreatedShare | null {
  const share = getShareByRequestId(db, requestId);
  if (!share) return null;
  const roomPeer = getPeer(db, `room://${share.slug}`);
  const roomCfg =
    roomPeer?.kind === "room" && roomPeer.config
      ? (JSON.parse(roomPeer.config) as {
          base: string;
          slug: string;
          lifecycle?: string;
        })
      : null;
  const activeRoom = roomCfg && (roomCfg.lifecycle ?? "active") === "active";
  if (roomCfg && !activeRoom) return null;
  const base = share.served_base ?? "";
  return {
    slug: share.slug,
    kind: share.kind,
    permission: share.permission,
    transport: "server",
    hosting: activeRoom ? "room" : "server",
    url: activeRoom
      ? roomUrlOf(roomCfg)
      : `${base.replace(/\/+$/, "")}/share/${share.slug}`,
    expiresAt: share.expires_at,
    source: activeRoom ? "Edge Room" : base || "本机服务器",
  };
}

export async function revokeShareByRequestId(
  db: DbDriver,
  requestId: string,
): Promise<RevokeShareResult> {
  const share = getShareByRequestId(db, requestId);
  return share ? revokeShareAction(db, share.slug) : { ok: false, status: "not_found" };
}

/** Aggregated listing for CLI/WebUI: local ∪ each paired peer's /api/shares
 *  (best-effort, bounded), deduped by slug. Optional target filter. */
export async function listSharesAggregated(db: DbDriver, targetId?: string): Promise<ShareListItem[]> {
  const bySlug = new Map<string, ShareListItem>();
  for (const item of await listSharesLocal(db, targetId)) bySlug.set(item.slug, item);

  await Promise.all(
    listShareServers(db).map(async ({ url, label }) => {
      const peer = getPeer(db, url);
      if (!peer?.token) return;
      const items = await fetchPeerShares(url, peer.token, targetId).catch(() => []);
      for (const it of items) {
        if (!bySlug.has(it.slug))
          bySlug.set(it.slug, {
            ...it,
            source: label,
            sourceKind: "peer",
            sourceUrl: url,
          });
      }
    }),
  );
  return [...bySlug.values()];
}

async function fetchPeerShares(url: string, token: string, targetId?: string): Promise<ShareListItem[]> {
  const u = `${url.replace(/\/+$/, "")}/api/shares${targetId ? `?target=${encodeURIComponent(targetId)}` : ""}`;
  const res = await Promise.race([
    fetch(u, { headers: { authorization: `Bearer ${token}` } }),
    new Promise<Response>((_r, rej) => setTimeout(() => rej(new Error("timeout")), PEER_LIST_TIMEOUT_MS)),
  ]);
  if (!res.ok) return [];
  return ((await res.json()) as ShareListItem[]).map((item) => ({
    ...item,
    ...(item.url ? { url: absoluteShareUrl(item.url, url) } : {}),
  }));
}

/** Revoke: local server row → delete it (cascading the share's room, if one is
 *  provisioned — final decision 3: the room's lifecycle is the share's); else a
 *  bucket holds it → delete objects. */
export interface RevokeShareResult {
  ok: boolean;
  status: "revoked" | "cleanup_pending" | "not_found";
}

export async function revokeShareAction(db: DbDriver, slug: string): Promise<RevokeShareResult> {
  if (getShare(db, slug)) {
    const channels = listSiteChannelRows(db).filter(
      (channel) =>
        channel.audience === "link" &&
        channel.target_ref === slug &&
        channel.desired_state === "active",
    );
    for (const channel of channels)
      setSiteChannelDesiredState(db, channel.id, "revoked");
    const { teardownRoomForShare } = await import("./room-peer.ts");
    const teardown = await teardownRoomForShare(db, slug);
    if (teardown === "cleanup_pending") {
      for (const channel of channels)
        putSiteChannelObservation(db, {
          channelId: channel.id,
          status: "cleanup_pending",
          lastError: "Edge 尚未确认销毁 Room",
        });
      return { ok: false, status: "cleanup_pending" };
    }
    const deleted = deleteShare(db, slug);
    for (const channel of channels)
      putSiteChannelObservation(db, {
        channelId: channel.id,
        status: "revoked",
        lastVerifiedAt: Date.now(),
      });
    return {
      ok: deleted,
      status: "revoked",
    };
  }
  for (const p of listPeers(db).filter((x) => x.kind === "s3" && x.config)) {
    const config = JSON.parse(p.config!) as S3Config;
    const metas = await listBucketShares(config).catch(() => []);
    if (metas.some((m) => m.slug === slug)) {
      await deleteBucketShareObjects(config, slug);
      return { ok: true, status: "revoked" };
    }
  }
  return { ok: false, status: "not_found" };
}

/** Renew an s3 share (re-presign, mint a fresh ≤7d link). */
export async function renewShareAction(db: DbDriver, slug: string, viewerBaseOverride?: string): Promise<CreatedShare> {
  for (const p of listPeers(db).filter((x) => x.kind === "s3" && x.config)) {
    const config = JSON.parse(p.config!) as S3Config;
    const metas = await listBucketShares(config).catch(() => []);
    const m = metas.find((x) => x.slug === slug);
    if (!m) continue;
    const base = viewerBase(db, viewerBaseOverride);
    const out = await renewBucketShare(db, config, slug);
    return {
      slug,
      kind: m.kind,
      permission: "view",
      transport: "s3",
      hosting: "s3",
      url: bucketLink(base, out.manifestUrl, out.keyB64, out.saltB64),
      expiresAt: out.presignExp,
      source: `桶 ${p.label ?? p.url}`,
    };
  }
  throw new MhError("not_found", `no such object-storage share: ${slug}`);
}

/** An unguessable slug that doesn't collide with a local server-share row. */
function freshSlug(db: DbDriver): string {
  let slug = randomSuffix(12);
  while (getShare(db, slug)) slug = randomSuffix(12);
  return slug;
}
