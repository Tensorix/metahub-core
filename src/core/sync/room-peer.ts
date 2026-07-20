// Owner-side wiring of kind='room' peers: the HTTP transport into a room's
// /r/<slug>/owner/* endpoints, the provision/teardown lifecycle bound to the
// share row (final decision 3: delete the share → destroy the room; the DATA's
// lifecycle stays with the CRDT), and the per-tick sync round that drives
// room-client's syncWithRoom. Node-side (fetch + blob resolution) — the
// portable halves live in room-client.ts / room-protocol.ts.

import type { DbDriver } from "../driver.ts";
import { MhError } from "../errors.ts";
import { randomSuffix } from "../ids.ts";
import { getShare, type ShareRow } from "../shares.ts";
import { parseGrantSet } from "../grants-core.ts";
import {
  addRoomPeer,
  getPeer,
  removePeer,
  type PeerRow,
  type RoomPeerConfig,
} from "./peers.ts";
import {
  syncWithRoom,
  ROOM_DIGEST_INTERVAL,
  type RoomTransport,
  type RoomSyncResult,
} from "./room-client.ts";
import { ROOM_BLOB_CHUNK_LIMIT, type OwnerSyncResponse } from "./room-protocol.ts";
import type { PartitionScope } from "./partition.ts";

export type RoomBlobResolver = (db: DbDriver, hash: string) => Promise<Uint8Array | null>;
let defaultBlobResolver: RoomBlobResolver | undefined;

/** Runtime adapter hook: Bun registers its blob resolver at server/CLI startup;
 * browser replicas register spool→bucket resolution in db-worker. */
export function registerRoomBlobResolver(resolve: RoomBlobResolver): void {
  defaultBlobResolver = resolve;
}

/** Synthetic peers.url key of a share's room. */
export function roomPeerKey(slug: string): string {
  return `room://${slug}`;
}

/** The guest-facing room URL (what the share link points at). */
export function roomUrlOf(config: Pick<RoomPeerConfig, "base" | "slug">): string {
  return `${config.base.replace(/\/+$/, "")}/r/${config.slug}/`;
}

function ownerUrl(config: RoomPeerConfig, sub: string): string {
  return `${config.base.replace(/\/+$/, "")}/r/${encodeURIComponent(config.slug)}/${sub}`;
}

function ownerHeaders(config: RoomPeerConfig, json = true): Record<string, string> {
  return {
    authorization: `Bearer ${config.ownerSecret}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

/** The wire for room-client: POST /owner/sync with the owner secret. Statuses
 *  map onto MhError codes; a protocol-major mismatch is the room's 409. */
export function roomTransport(config: RoomPeerConfig): RoomTransport {
  return async (req) => {
    let res: Response;
    try {
      res = await fetch(ownerUrl(config, "owner/sync"), {
        method: "POST",
        headers: ownerHeaders(config),
        body: JSON.stringify(req),
      });
    } catch (e) {
      throw new MhError("network", `room ${config.slug} unreachable: ${(e as Error).message}`);
    }
    if (res.status === 409)
      throw new MhError("conflict", "room protocol outdated — run `mh edge deploy`");
    if (res.status === 401) throw new MhError("auth", `room ${config.slug} refused the owner secret`);
    if (res.status === 404)
      throw new MhError(
        "not_found",
        `room ${config.slug} is not provisioned — re-create the share with --room`,
      );
    if (!res.ok) throw new MhError("network", `room sync failed: HTTP ${res.status}`);
    return (await res.json()) as OwnerSyncResponse;
  };
}

// Per-peer digest cadence (in-memory by design — a missed digest round after a
// restart just delays anti-entropy by <16 rounds, never loses data).
const digestState = new Map<string, { rounds: number; lastGrants: string | null }>();

/** Cap on the pending-continuation loop within one sync call (seed rounds). */
const MAX_ROUNDS = 50;

/**
 * One owner→room sync pass for a kind='room' peer: derive the partition scope
 * from the CURRENT share row (re-grants apply immediately), loop syncWithRoom
 * until quiescent, then push any blob bytes the room asked for. Called from
 * peers.ts syncPeerOnce (which records last_status) and from the first seed.
 *
 * Lifecycle self-healing: a room peer whose share row is gone (revoke should
 * have torn it down — e.g. a crash in between) destroys the room best-effort
 * and removes itself; an "expired" answer tears the peer down likewise.
 */
export async function syncRoomPeer(
  db: DbDriver,
  peer: PeerRow,
  opts: {
    resolveBlob?: RoomBlobResolver;
  } = {},
): Promise<{ pushed: number; pulled: number; pendingPush: boolean }> {
  if (!peer.config) throw new MhError("invalid_input", `room peer ${peer.url} has no config`);
  const config = JSON.parse(peer.config) as RoomPeerConfig;

  const share = getShare(db, config.slug);
  if (!share) {
    await destroyRoom(config).catch(() => undefined); // best-effort
    removePeer(db, peer.url);
    return { pushed: 0, pulled: 0, pendingPush: false };
  }

  const scope: PartitionScope = {
    grantedDbIds: parseGrantSet(share.grants).tables.map((t) => t.db),
    siteId: share.kind === "site" ? share.target_id : null,
  };
  const guestBase = config.guestBase ?? share.guest_node_id;
  if (!guestBase)
    throw new MhError(
      "invalid_input",
      `room peer ${peer.url} has no guest base id — revoke and re-create the share with --room`,
    );

  const st = digestState.get(peer.url) ?? { rounds: 0, lastGrants: share.grants };
  const transport = roomTransport(config);
  let pushed = 0;
  let pulled = 0;
  let needBlobs: string[] = [];
  let pending = false;
  for (let i = 0; i < MAX_ROUNDS; i++) {
    st.rounds++;
    // Digest every ROOM_DIGEST_INTERVAL rounds, plus right after a grants change.
    const digest = st.rounds % ROOM_DIGEST_INTERVAL === 0 || st.lastGrants !== share.grants;
    st.lastGrants = share.grants;
    digestState.set(peer.url, st);

    const r: RoomSyncResult = await syncWithRoom(
      db,
      { peerKey: peer.url, scope, guestBase },
      transport,
      { digest },
    );
    if (r.shareState === "expired") {
      // Revoked/expired at the room: tear the peer down (the room self-destroys
      // via its own alarm; destroy here is redundant but harmless best-effort).
      await destroyRoom(config).catch(() => undefined);
      removePeer(db, peer.url);
      return { pushed, pulled, pendingPush: false };
    }
    pushed += r.pushed;
    pulled += r.pulled;
    needBlobs = r.needBlobs;
    pending = r.pending;
    if (!r.pending) break;
  }
  if (needBlobs.length > 0) await pushRoomBlobs(db, config, needBlobs, opts.resolveBlob);
  // Report the truth: if we exhausted MAX_ROUNDS with work still queued,
  // pendingPush stays true so the caller can re-enter promptly instead of
  // waiting a full auto-sync tick (a large backlog would otherwise drip out one
  // round per tick).
  return { pushed, pulled, pendingPush: pending };
}

/**
 * Push blob bytes the room asked for (site_files rows with encoding='blob'
 * store only the hash — the bytes never ride the oplog). Chunked ≤1MiB per
 * POST; a hash whose bytes this node can't resolve right now is skipped (the
 * room re-asks every round until someone answers). `resolve` is injectable
 * for tests.
 */
export async function pushRoomBlobs(
  db: DbDriver,
  config: RoomPeerConfig,
  hashes: string[],
  resolve?: (db: DbDriver, hash: string) => Promise<Uint8Array | null>,
): Promise<number> {
  const resolveBytes = resolve ?? defaultBlobResolver;
  if (!resolveBytes) return 0;
  let sent = 0;
  for (const hash of hashes) {
    if (!/^[0-9a-f]{16,64}$/.test(hash)) continue; // never echo junk into a URL
    const bytes = await resolveBytes(db, hash).catch(() => null);
    if (!bytes) continue;
    const total = Math.max(1, Math.ceil(bytes.byteLength / ROOM_BLOB_CHUNK_LIMIT));
    let ok = true;
    for (let idx = 0; idx < total && ok; idx++) {
      const chunk = bytes.subarray(idx * ROOM_BLOB_CHUNK_LIMIT, (idx + 1) * ROOM_BLOB_CHUNK_LIMIT);
      const body = new Uint8Array(chunk.byteLength);
      body.set(chunk);
      const res = await fetch(
        `${ownerUrl(config, `owner/blob/${hash}`)}?idx=${idx}&total=${total}`,
        {
          method: "POST",
          headers: { ...ownerHeaders(config, false), "content-type": "application/octet-stream" },
          body: body.buffer,
        },
      ).catch(() => null);
      ok = !!res?.ok;
    }
    if (ok) sent++;
  }
  return sent;
}

/**
 * Provision a room for a freshly created share and run the first seed:
 * POST /owner/provision (grants snapshot + password verifier + guest base +
 * expiry) → register the kind='room' peer → sync rounds until quiescent.
 * Returns the guest-facing room URL.
 */
export async function provisionRoomForShare(
  db: DbDriver,
  share: ShareRow,
  edge: { endpoint: string; token: string },
  resolveBlob?: RoomBlobResolver,
): Promise<{ url: string; peerKey: string }> {
  const config: RoomPeerConfig = {
    base: edge.endpoint.replace(/\/+$/, ""),
    slug: share.slug,
    ownerSecret: edge.token,
    // Read-only shares carry no guest node id — mint one anyway so the room
    // has a stable base for (future) per-visitor sub ids, persisted in the
    // node-local peer config alongside the rest of the connection settings.
    guestBase: share.guest_node_id ?? "g" + randomSuffix(8),
  };
  let res: Response;
  try {
    res = await fetch(ownerUrl(config, "owner/provision"), {
      method: "POST",
      headers: ownerHeaders(config),
      body: JSON.stringify({
        slug: share.slug,
        guestBase: config.guestBase,
        grants: share.grants,
        pwHash: share.pw_hash,
        pwSalt: share.pw_salt,
        expiresAt: share.expires_at,
      }),
    });
  } catch (e) {
    throw new MhError("network", `edge worker unreachable: ${(e as Error).message}`);
  }
  if (res.status === 401) throw new MhError("auth", "edge worker refused the owner secret");
  if (res.status === 404)
    throw new MhError(
      "not_found",
      "the deployed edge worker has no room support — run `mh edge deploy` to upgrade it",
    );
  if (!res.ok) throw new MhError("network", `room provisioning failed: HTTP ${res.status}`);

  const peerKey = roomPeerKey(share.slug);
  addRoomPeer(db, { url: peerKey, config, label: `room ${share.slug}` });
  const peer = getPeer(db, peerKey)!;
  await syncRoomPeer(db, peer, { resolveBlob }); // first seed, loops until quiescent
  return { url: roomUrlOf(config), peerKey };
}

/** POST /owner/destroy — the room wipes its storage and drops every socket. */
export async function destroyRoom(config: RoomPeerConfig): Promise<boolean> {
  const res = await fetch(ownerUrl(config, "owner/destroy"), {
    method: "POST",
    headers: ownerHeaders(config),
  });
  return res.ok;
}

/**
 * Tear down the room bound to a share, if any: best-effort destroy (an
 * unreachable edge must never block a revoke) + remove the peer row. Returns
 * whether a room peer existed. Hooked into revokeShareAction so `mh share
 * revoke` / the WebUI revoke both cascade (final decision 3).
 */
export async function teardownRoomForShare(db: DbDriver, slug: string): Promise<boolean> {
  const peer = getPeer(db, roomPeerKey(slug));
  if (!peer || peer.kind !== "room" || !peer.config) return false;
  try {
    await destroyRoom(JSON.parse(peer.config) as RoomPeerConfig);
  } catch {
    /* best-effort — the peer row still goes */
  }
  removePeer(db, peer.url);
  digestState.delete(peer.url);
  return true;
}
