// Unified device roster — the one derived answer to "which devices touch this
// workspace, how did each join, and can I kick one out". Device identity lives
// in three scattered stores (outbound peers, inbound pairing grants, and the
// oplog's per-node change streams — the only trace of a purely bucket-joined
// device); this module folds them into ONE list with an honest revocability
// verdict per device, so the CLI and the settings page answer identically.
//
// Offline-first: the local oplog IS the roster (every node whose ops ever
// reached this device has rows in crdt_changes, and the max HLC is a real
// last-activity timestamp). refreshBucketPresence() adds the online-only bits
// (does the node's segment stream exist in a bucket / is its publisher
// heartbeat live) on demand — never in the default listing.

import type { DbDriver } from "../driver.ts";
import { MhError } from "../errors.ts";
import { parseHlc } from "../hlc.ts";
import { getNodeId, getNodeLabel } from "../node.ts";
import { listPeers, getPeer } from "./peers.ts";
import { listGrants } from "./pairing.ts";
import {
  storageClientFor,
  storageBasePrefix,
  listRemoteNodes,
  type S3Config,
} from "./storage.ts";

/** One way a device is connected to this node. */
export interface DeviceChannel {
  /** paired_out = an outbound peer row here; grant_in = a credential we issued
   *  to it; oplog = its changes reached us (bucket or historic sync). */
  kind: "paired_out" | "grant_in" | "oplog";
  /** peer url (paired_out) / full grant token (grant_in; surfaces mask it) /
   *  "" (oplog). */
  ref: string;
  lastSeenAt: number | null;
  transport?: "http" | "s3" | "room";
}

/**
 * yes           — one-click: revoke the grant and/or remove the peer row.
 * bucket_rotate — only reachable through the shared bucket key: cutting it off
 *                 means rotating the bucket credentials (rotateStoragePeer).
 * none          — this device itself, or nothing to revoke.
 */
export type Revocable = "yes" | "bucket_rotate" | "none";

export interface DeviceView {
  /** null: a grant that never learned its peer's node id (one-directional). */
  nodeId: string | null;
  label: string | null;
  self: boolean;
  channels: DeviceChannel[];
  lastActivityAt: number | null;
  revocable: Revocable;
}

/** Fold the three stores into one per-device list: self first, then by most
 *  recent activity. Purely local reads — same answer offline. */
export function listDevices(db: DbDriver): DeviceView[] {
  const self = getNodeId(db);
  const byNode = new Map<string, DeviceView>();
  const ensure = (nodeId: string): DeviceView => {
    let v = byNode.get(nodeId);
    if (!v) {
      v = { nodeId, label: null, self: nodeId === self, channels: [], lastActivityAt: null, revocable: "none" };
      byNode.set(nodeId, v);
    }
    return v;
  };

  ensure(self).label = getNodeLabel(db);

  const oplog = db
    .query("SELECT node_id, MAX(hlc) AS h FROM crdt_changes GROUP BY node_id")
    .all() as { node_id: string; h: string }[];
  for (const r of oplog)
    ensure(r.node_id).channels.push({ kind: "oplog", ref: "", lastSeenAt: parseHlc(r.h).millis });

  const peers = listPeers(db);
  for (const p of peers) {
    if (!p.node_id) continue;
    const v = ensure(p.node_id);
    if (!v.label) v.label = p.label;
    v.channels.push({
      kind: "paired_out",
      ref: p.url,
      lastSeenAt: p.last_success_at,
      transport: p.kind === "s3" || p.kind === "room" ? (p.kind as "s3" | "room") : "http",
    });
  }

  const standalone: DeviceView[] = [];
  for (const g of listGrants(db)) {
    const ch: DeviceChannel = { kind: "grant_in", ref: g.token, lastSeenAt: g.created_at };
    if (g.node_id) ensure(g.node_id).channels.push(ch);
    else
      standalone.push({
        nodeId: null,
        label: null,
        self: false,
        channels: [ch],
        lastActivityAt: g.created_at,
        revocable: "yes",
      });
  }

  const hasBucket = peers.some((p) => p.kind === "s3" && p.enabled);
  const views = [...byNode.values()].map((v) => {
    const last = v.channels.reduce<number | null>(
      (m, c) => (c.lastSeenAt != null && (m == null || c.lastSeenAt > m) ? c.lastSeenAt : m),
      null,
    );
    const direct = v.channels.some((c) => c.kind === "paired_out" || c.kind === "grant_in");
    const revocable: Revocable = v.self ? "none" : direct ? "yes" : hasBucket ? "bucket_rotate" : "none";
    return { ...v, lastActivityAt: last, revocable };
  });
  views.sort(
    (a, b) => Number(b.self) - Number(a.self) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0),
  );
  return [...views, ...standalone];
}

export interface BucketPresence {
  nodeId: string;
  /** The node's own segment stream exists under oplog/ in this bucket. */
  inBucket: boolean;
  /** Publisher heartbeat expiry when live (≈ "recently online"), else null. */
  leaseLiveUntil: number | null;
}

/** Online refresh for one bucket: which nodes' streams live in it and whose
 *  publisher heartbeat is fresh. Resolves the honest classification for devices
 *  the offline listing could only call "通过存储桶或历史同步". */
export async function refreshBucketPresence(db: DbDriver, url: string): Promise<BucketPresence[]> {
  const peer = getPeer(db, url);
  if (!peer || peer.kind !== "s3" || !peer.config)
    throw new MhError("not_found", `no S3 storage peer at '${url}'`);
  const config = JSON.parse(peer.config) as S3Config;
  const client = storageClientFor(config);
  const base = storageBasePrefix(config.prefix);
  const nodes = await listRemoteNodes(client, base);
  const liveUntil = new Map<string, number>();
  const now = Date.now();
  for (const o of await client.list(`${base}/publisher/`)) {
    const m = /\/publisher\/(.+)\.lease$/.exec(o.key);
    if (!m) continue;
    const bytes = await client.get(o.key);
    if (!bytes) continue;
    try {
      const hb = JSON.parse(new TextDecoder().decode(bytes)) as { node?: string; expiresAt?: number };
      if (typeof hb.expiresAt === "number" && hb.expiresAt > now) liveUntil.set(m[1]!, hb.expiresAt);
    } catch {
      // unreadable heartbeat — ignore
    }
  }
  const all = new Set([...nodes, ...liveUntil.keys()]);
  return [...all].map((nodeId) => ({
    nodeId,
    inBucket: nodes.includes(nodeId),
    leaseLiveUntil: liveUntil.get(nodeId) ?? null,
  }));
}
