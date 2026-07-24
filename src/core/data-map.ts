// Data map — the one derived answer to "where does my data live, how fresh is
// each copy, and is anything not yet backed up". A workspace's bytes can sit in
// several places (this node's own library, paired device nodes, object-storage
// buckets), whose state lives in scattered stores (peers rows + sync status,
// the blob ledger's pending flags, the synced blob policy). This module folds
// them into ONE place list + ONE summary state so every surface (mh status,
// the settings sync header) answers identically instead of re-deriving its own
// precedence.
//
// PURE + portable (no driver, no node:/bun:): callers hand in the rows they
// already hold. The db-reading convenience wrapper lives in
// sync/data-map-db.ts.

/** One outbound sync target, pre-fetched by the caller (peers row + parsed
 *  s3 config extras). Room peers must be excluded by the caller — a room holds
 *  one share's partition, not the workspace. */
export interface DataMapPeerInput {
  url: string;
  kind: "http" | "s3";
  label: string | null;
  nodeId: string | null;
  enabled: boolean;
  /** Last successful sync (freshness gates use this, never last attempt). */
  lastSuccessAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
  /** s3 only: bucket name from config (display fallback). */
  bucket?: string | null;
  /** s3 only: this node is configured to publish full snapshots to it. */
  publish?: boolean;
}

export interface DataMapInput {
  selfNodeId: string;
  selfLabel: string | null;
  peers: DataMapPeerInput[];
  /** Count/bytes of blobs produced here not yet flushed to a durable anchor. */
  pendingBlobCount: number;
  pendingBlobBytes: number;
  /** Designated full-blob anchors: node ids and/or bucket s3:// urls. */
  blobFullNodes: string[];
  now?: number;
}

/** One place holding (or configured to hold) a copy of the workspace. */
export interface DataPlace {
  kind: "self" | "device" | "bucket";
  /** Peer url; null for self. */
  url: string | null;
  /** Display name: label ?? bucket ?? url host segment. */
  label: string;
  /**
   * live      — this node's own library (always current)
   * synced    — has synced successfully; syncedAt says when
   * error     — last sync failed (lastError says why); may still hold old data
   * never     — configured but no successful sync yet (holds nothing)
   * disabled  — configured but turned off
   */
  freshness: "live" | "synced" | "error" | "never" | "disabled";
  syncedAt: number | null;
  error: string | null;
  /**
   * replica     — a full node (device) holding the whole workspace
   * backend     — a dumb bucket store (holds segments/snapshots, not queryable)
   * blob_anchor — designated durable full-blob library
   * publisher   — bucket only: THIS node is configured as its snapshot
   *               publisher (static config flag; live election is bucket-side
   *               and not knowable offline — surfaces say "configured as").
   */
  roles: ("replica" | "backend" | "blob_anchor" | "publisher")[];
}

/** Precedence-ordered summary. Attention states first (something needs the
 *  user), then transitional, then quiescent. */
export type DataMapStateKind =
  | "no_backup" // data exists ONLY here: no enabled sync target configured
  | "pending_blobs" // some bytes produced here not yet at any durable anchor
  | "peer_error" // a backup place is failing to sync
  | "syncing" // first sync to a configured place hasn't completed yet
  | "healthy"; // every enabled place has synced

export interface DataMapState {
  state: DataMapStateKind;
  /** Places that actually hold data now (self + successfully-synced peers). */
  places: number;
  pendingBlobCount: number;
  pendingBlobBytes: number;
  /** Oldest last-success among enabled synced places — the freshness anchor
   *  (null when self is the only place). */
  oldestSyncedAt: number | null;
}

const hostOf = (url: string): string => {
  const m = /^[a-z0-9+]+:\/\/([^/]+)/i.exec(url);
  return m ? m[1]! : url;
};

function placeOf(p: DataMapPeerInput, fullNodes: string[]): DataPlace {
  const isBucket = p.kind === "s3";
  const roles: DataPlace["roles"] = isBucket ? ["backend"] : ["replica"];
  const anchorKey = isBucket ? p.url : p.nodeId;
  if (anchorKey && fullNodes.includes(anchorKey)) roles.push("blob_anchor");
  if (isBucket && p.publish) roles.push("publisher");
  return {
    kind: isBucket ? "bucket" : "device",
    url: p.url,
    label: p.label ?? (isBucket ? (p.bucket ?? hostOf(p.url)) : hostOf(p.url)),
    freshness: !p.enabled
      ? "disabled"
      : p.lastStatus === "error"
        ? "error"
        : p.lastSuccessAt != null
          ? "synced"
          : "never",
    syncedAt: p.lastSuccessAt,
    error: p.lastStatus === "error" ? (p.lastError ?? null) : null,
    roles,
  };
}

/** Fold the scattered stores into the ordered place list: self first, then
 *  devices, then buckets; within a kind, synced before never/disabled. */
export function dataPlaces(input: DataMapInput): DataPlace[] {
  const self: DataPlace = {
    kind: "self",
    url: null,
    label: input.selfLabel ?? "本机",
    freshness: "live",
    syncedAt: null,
    error: null,
    roles: input.blobFullNodes.includes(input.selfNodeId)
      ? ["replica", "blob_anchor"]
      : ["replica"],
  };
  const rank = (f: DataPlace["freshness"]) =>
    f === "synced" ? 0 : f === "error" ? 1 : f === "never" ? 2 : 3;
  const rest = input.peers
    .map((p) => placeOf(p, input.blobFullNodes))
    .sort(
      (a, b) =>
        Number(a.kind === "bucket") - Number(b.kind === "bucket") ||
        rank(a.freshness) - rank(b.freshness) ||
        a.label.localeCompare(b.label),
    );
  return [self, ...rest];
}

/** The single precedence everyone must agree on (mh status, settings header). */
export function dataMapState(input: DataMapInput): DataMapState {
  const places = dataPlaces(input);
  const enabled = places.filter((p) => p.kind !== "self" && p.freshness !== "disabled");
  const synced = enabled.filter((p) => p.freshness === "synced" || p.freshness === "error");
  // error places still HOLD previously-synced data — count the ones that ever
  // succeeded; a place that errored before its first success holds nothing.
  const holding = synced.filter((p) => p.syncedAt != null);
  const oldest = holding.length
    ? holding.reduce<number | null>(
        (min, p) => (min == null || (p.syncedAt ?? 0) < min ? p.syncedAt : min),
        null,
      )
    : null;
  const base = {
    places: 1 + holding.length,
    pendingBlobCount: input.pendingBlobCount,
    pendingBlobBytes: input.pendingBlobBytes,
    oldestSyncedAt: oldest,
  };
  if (enabled.length === 0) return { state: "no_backup", ...base };
  if (input.pendingBlobCount > 0) return { state: "pending_blobs", ...base };
  if (enabled.some((p) => p.freshness === "error")) return { state: "peer_error", ...base };
  if (enabled.some((p) => p.freshness === "never")) return { state: "syncing", ...base };
  return { state: "healthy", ...base };
}
