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

const DEFAULT_SHARE_VIEWER = "https://share.mh.tensorix.org";
const DEFAULT_S3_EXPIRY_SEC = MAX_PRESIGN_SECONDS;
const PEER_LIST_TIMEOUT_MS = 4000;

export interface CreateShareRequest {
  kind: ShareKind;
  ref: string;
  permission?: SharePermission;
  transport?: "server" | "s3";
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
}

export interface CreatedShare {
  slug: string;
  kind: ShareKind;
  permission: SharePermission;
  transport: "server" | "s3";
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
  sourceKind: "server" | "peer" | "bucket";
  /** Where the share is actually served from: this/a server, an always-on DO
   *  room (server share + kind='room' peer), or a bucket export. */
  hosting?: "server" | "room" | "s3";
  expiresAt: number | null;
  hasPassword: boolean;
  /** server: ready-to-copy link; s3: omitted (use renew to mint a fresh one). */
  url?: string;
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

/** Paired HTTP peer servers (a share can be created on / served by them). */
export function listShareServers(db: DbDriver): { url: string; label: string }[] {
  return listPeers(db)
    .filter((p) => p.kind !== "s3")
    .map((p) => ({ url: p.url, label: p.label ?? p.url }));
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

/** Resolve, validate, and create (server local / server remote / s3 bucket) a share. */
export async function createShareAction(db: DbDriver, req: CreateShareRequest): Promise<CreatedShare> {
  const permission = req.permission ?? "view";
  const transport = req.transport ?? "server";

  // ── object storage ──────────────────────────────────────────────────────────
  if (transport === "s3") {
    if (req.grants)
      throw new MhError("invalid_input", "data grants need the server transport — a static object-storage share has no API surface");
    if (permission === "edit")
      throw new MhError("invalid_input", "object-storage shares are read-only — use the server transport to allow editing");
    if (req.kind === "site")
      throw new MhError("invalid_input", "sites can't be shared via object storage — use the server transport");
    const target = resolveTarget(db, req.kind, req.ref);
    const bucketUrl = pickBucket(db, req.bucketUrl);
    const { config, label } = s3PeerConfig(db, bucketUrl);
    const base = viewerBase(db, req.viewerBase);
    const slug = freshSlug(db);
    const out = await createBucketShare(db, {
      slug,
      kind: req.kind,
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
      url: bucketLink(base, out.manifestUrl, out.keyB64, out.saltB64),
      expiresAt: out.presignExp,
      source: `桶 ${label}`,
    };
  }

  // ── server: remote (a paired peer) ────────────────────────────────────────────
  const peer = req.server ? getPeer(db, req.server) : null;
  if (req.server && peer && peer.kind !== "s3") {
    const res = await fetch(`${req.server.replace(/\/+$/, "")}/api/share`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(peer.token ? { authorization: `Bearer ${peer.token}` } : {}),
      },
      body: JSON.stringify({ ...req, server: undefined }),
    }).catch((e) => {
      throw new MhError("network", `could not reach ${req.server}: ${(e as Error).message}`);
    });
    const data = (await res.json().catch(() => ({}))) as Partial<CreatedShare> & { error?: string };
    if (!res.ok) throw new MhError("network", data.error || `remote share failed: ${res.status}`);
    return {
      slug: data.slug!,
      kind: req.kind,
      permission,
      transport: "server",
      url: data.url!,
      expiresAt: data.expiresAt ?? null,
      source: peer.label ?? req.server,
    };
  }

  // ── server: local ─────────────────────────────────────────────────────────────
  const target = resolveTarget(db, req.kind, req.ref);
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
  });
  return {
    slug: share.slug,
    kind: req.kind,
    permission,
    transport: "server",
    url: `${servedBase ?? ""}/share/${share.slug}`,
    expiresAt: share.expires_at,
    source: servedBase || "本机服务器",
  };
}

/** Local listing (server rows + each attached bucket) — NO peer fan-out (so the
 *  /api/shares endpoint a peer calls can't recurse). Optional target filter. */
export async function listSharesLocal(db: DbDriver, targetId?: string): Promise<ShareListItem[]> {
  const out: ShareListItem[] = [];
  const rows = targetId ? listSharesForTarget(db, targetId) : listShares(db);
  for (const r of rows) {
    // A kind='room' peer bound to the slug marks the share as room-hosted; its
    // always-on link is the room URL (the local /share link keeps working too).
    const roomPeer = getPeer(db, `room://${r.slug}`);
    const roomCfg =
      roomPeer?.kind === "room" && roomPeer.config
        ? (JSON.parse(roomPeer.config) as { base?: string; slug?: string })
        : null;
    const roomUrl =
      roomCfg?.base && roomCfg.slug
        ? `${roomCfg.base.replace(/\/+$/, "")}/r/${roomCfg.slug}/`
        : null;
    out.push({
      slug: r.slug,
      kind: r.kind,
      target_id: r.target_id,
      title: targetTitle(db, r.kind, r.target_id),
      permission: r.permission,
      transport: "server",
      source: roomUrl ? `房间 ${r.slug}` : r.served_base || "本机服务器",
      sourceKind: "server",
      hosting: roomUrl ? "room" : "server",
      expiresAt: r.expires_at,
      hasPassword: !!r.pw_hash,
      url: roomUrl ?? (r.served_base ? `${r.served_base}/share/${r.slug}` : `/share/${r.slug}`),
    });
  }
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
        if (!bySlug.has(it.slug)) bySlug.set(it.slug, { ...it, source: label, sourceKind: "peer" });
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
  return (await res.json()) as ShareListItem[];
}

/** Revoke: local server row → delete it (cascading the share's room, if one is
 *  provisioned — final decision 3: the room's lifecycle is the share's); else a
 *  bucket holds it → delete objects. */
export async function revokeShareAction(db: DbDriver, slug: string): Promise<boolean> {
  if (getShare(db, slug)) {
    // Best-effort room teardown (destroy + peer removal) — lazy import keeps
    // the room pipeline off this module's startup path.
    const { teardownRoomForShare } = await import("./room-peer.ts");
    await teardownRoomForShare(db, slug).catch(() => undefined);
    return deleteShare(db, slug);
  }
  for (const p of listPeers(db).filter((x) => x.kind === "s3" && x.config)) {
    const config = JSON.parse(p.config!) as S3Config;
    const metas = await listBucketShares(config).catch(() => []);
    if (metas.some((m) => m.slug === slug)) {
      await deleteBucketShareObjects(config, slug);
      return true;
    }
  }
  return false;
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
