// Convenience wrapper over data-map for callers holding a db handle (CLI,
// server routes, browser worker): gathers this node's stores and returns the
// derived view. Reads ONLY local tables — zero network — so it answers the
// same offline (bucket-side facts like the live publisher election are
// deliberately out of scope; see data-map.ts role docs).

import type { DbDriver } from "../driver.ts";
import {
  dataPlaces,
  dataMapState,
  type DataMapInput,
  type DataMapPeerInput,
  type DataPlace,
  type DataMapState,
} from "../data-map.ts";
import { getNodeId, getNodeLabel } from "../node.ts";
import { pendingBlobs, readPolicy } from "../blobs-core.ts";
import { listPeers } from "./peers.ts";
import type { S3Config } from "./storage.ts";

export interface DataMap {
  state: DataMapState;
  places: DataPlace[];
}

export function dataMap(db: DbDriver): DataMap {
  const selfNodeId = getNodeId(db);
  const high = db
    .query(
      "SELECT MAX(seq) AS global_seq, MAX(CASE WHEN node_id = ? THEN seq END) AS own_seq FROM crdt_changes",
    )
    .get(selfNodeId) as { global_seq: number | null; own_seq: number | null };
  const interval = db
    .query("SELECT value FROM meta WHERE key = 'cfg_sync_interval'")
    .get() as { value: string } | null;
  const syncIntervalMs = Number(interval?.value);
  const staleAfterMs = Math.max(
    15 * 60 * 1000,
    Number.isFinite(syncIntervalMs) && syncIntervalMs > 0 ? syncIntervalMs * 3 : 0,
  );
  const peers: DataMapPeerInput[] = listPeers(db)
    .filter((p) => p.kind === "http" || p.kind === "s3")
    .map((p) => {
      let bucket: string | null = null;
      let publish: boolean | undefined;
      if (p.kind === "s3" && p.config) {
        try {
          const cfg = JSON.parse(p.config) as S3Config;
          bucket = cfg.bucket ?? null;
          publish = cfg.publish;
        } catch {
          // malformed config — display falls back to the url
        }
      }
      return {
        url: p.url,
        kind: p.kind as "http" | "s3",
        label: p.label,
        nodeId: p.node_id,
        enabled: !!p.enabled,
        lastSuccessAt: p.last_success_at,
        lastStatus: p.last_status,
        lastError: p.last_error,
        pushCursor: p.push_cursor,
        bucket,
        publish,
      };
    });
  const pending = pendingBlobs(db);
  const input: DataMapInput = {
    selfNodeId,
    selfLabel: getNodeLabel(db),
    peers,
    pendingBlobCount: pending.length,
    pendingBlobBytes: pending.reduce((sum, b) => sum + b.size, 0),
    blobFullNodes: readPolicy(db).fullNodes,
    globalHighWaterSeq: high.global_seq ?? 0,
    ownHighWaterSeq: high.own_seq ?? 0,
    staleAfterMs,
  };
  return { state: dataMapState(input), places: dataPlaces(input) };
}
