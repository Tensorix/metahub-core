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
  /** Highest local sequence durably acknowledged by this target. */
  pushCursor: number;
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
  /** Latest sequence in the whole local oplog (HTTP peers replicate this). */
  globalHighWaterSeq: number;
  /** Latest sequence authored by this node (S3 publishes per-node streams). */
  ownHighWaterSeq: number;
  /** A current copy older than this is shown as stale, not healthy. */
  staleAfterMs?: number;
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
   * current   — target acknowledged the relevant local high-water mark
   * behind    — target holds an older copy but local changes are unacknowledged
   * stale     — cursor is current, but the last confirmation is too old
   * error     — last sync failed (lastError says why); may still hold old data
   * never     — configured but no successful sync yet (holds nothing)
   * disabled  — configured but turned off
   */
  freshness: "live" | "current" | "behind" | "stale" | "error" | "never" | "disabled";
  syncedAt: number | null;
  error: string | null;
  acknowledgedSeq: number;
  highWaterSeq: number;
  lag: number;
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
  | "unsynced_changes" // at least one enabled target has not acked current ops
  | "peer_error" // a backup place is failing to sync
  | "syncing" // first sync to a configured place hasn't completed yet
  | "stale" // cursors are current but confirmation is too old
  | "healthy"; // every enabled place has synced

/** One concrete problem, kept alongside the single headline `state` so
 *  concurrent issues (a failing peer AND unsynced changes) are never masked by
 *  precedence — the headline picks one, `issues` lists them all. */
export interface DataMapIssue {
  kind: "no_backup" | "peer_error" | "never_synced" | "behind" | "stale" | "pending_blobs";
  /** Peer url the issue is about; null for workspace-level issues. */
  placeUrl: string | null;
  placeLabel: string | null;
  /** peer_error carries lastError; others null. */
  message: string | null;
}

export interface DataMapState {
  state: DataMapStateKind;
  /** Places that actually hold data now (self + successfully-synced peers). */
  places: number;
  pendingBlobCount: number;
  pendingBlobBytes: number;
  /** Maximum replication-cursor gap. This is a health signal, not an exact
   * user-edit count (filtered streams can contain sequence gaps). */
  pendingChanges: number;
  /** Oldest last-success among enabled synced places — the freshness anchor
   *  (null when self is the only place). */
  oldestSyncedAt: number | null;
  /** Every concurrent problem, most severe first (same order as the headline
   *  precedence). Empty when healthy. */
  issues: DataMapIssue[];
}

const hostOf = (url: string): string => {
  const m = /^[a-z0-9+]+:\/\/([^/]+)/i.exec(url);
  return m ? m[1]! : url;
};

function placeOf(
  p: DataMapPeerInput,
  fullNodes: string[],
  globalHighWaterSeq: number,
  ownHighWaterSeq: number,
  now: number,
  staleAfterMs: number,
): DataPlace {
  const isBucket = p.kind === "s3";
  const highWaterSeq = isBucket ? ownHighWaterSeq : globalHighWaterSeq;
  const lag = Math.max(0, highWaterSeq - p.pushCursor);
  const roles: DataPlace["roles"] = isBucket ? ["backend"] : ["replica"];
  const anchorKey = isBucket ? p.url : p.nodeId;
  if (anchorKey && fullNodes.includes(anchorKey)) roles.push("blob_anchor");
  if (isBucket && p.publish) roles.push("publisher");
  return {
    kind: isBucket ? "bucket" : "device",
    url: p.url,
    label: p.label ?? (isBucket ? (p.bucket ?? hostOf(p.url)) : hostOf(p.url)),
    // Error outranks "never": a target that keeps failing must say so, not
    // hide behind "first sync hasn't completed yet" (misconfigured bucket /
    // wrong token is exactly the never+error combination).
    freshness: !p.enabled
      ? "disabled"
      : p.lastStatus === "error"
        ? "error"
        : p.lastSuccessAt == null
          ? "never"
          : lag > 0
            ? "behind"
            : now - p.lastSuccessAt > staleAfterMs
              ? "stale"
              : "current",
    syncedAt: p.lastSuccessAt,
    error: p.lastStatus === "error" ? (p.lastError ?? null) : null,
    acknowledgedSeq: p.pushCursor,
    highWaterSeq,
    lag,
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
    acknowledgedSeq: input.globalHighWaterSeq,
    highWaterSeq: input.globalHighWaterSeq,
    lag: 0,
    roles: input.blobFullNodes.includes(input.selfNodeId)
      ? ["replica", "blob_anchor"]
      : ["replica"],
  };
  const rank = (f: DataPlace["freshness"]) =>
    f === "current"
      ? 0
      : f === "stale"
        ? 1
        : f === "behind"
          ? 2
          : f === "error"
            ? 3
            : f === "never"
              ? 4
              : 5;
  const now = input.now ?? Date.now();
  const staleAfterMs = input.staleAfterMs ?? 24 * 60 * 60 * 1000;
  const rest = input.peers
    .map((p) =>
      placeOf(
        p,
        input.blobFullNodes,
        input.globalHighWaterSeq,
        input.ownHighWaterSeq,
        now,
        staleAfterMs,
      ),
    )
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
  // `places` means confirmed holders of the CURRENT local version. Older
  // copies remain visible in the expanded list but do not inflate safety.
  const current = enabled.filter(
    (p) => p.syncedAt != null && p.acknowledgedSeq >= p.highWaterSeq,
  );
  const oldest = current.length
    ? current.reduce<number | null>(
        (min, p) => (min == null || (p.syncedAt ?? 0) < min ? p.syncedAt : min),
        null,
      )
    : null;
  const pendingChanges = enabled.reduce((max, p) => Math.max(max, p.lag), 0);
  // Collect EVERY concurrent problem (most severe first) — the headline state
  // below picks one by precedence, but nothing gets masked.
  const issues: DataMapIssue[] = [];
  if (enabled.length === 0)
    issues.push({ kind: "no_backup", placeUrl: null, placeLabel: null, message: null });
  for (const p of enabled)
    if (p.freshness === "error")
      issues.push({ kind: "peer_error", placeUrl: p.url, placeLabel: p.label, message: p.error });
  if (input.pendingBlobCount > 0)
    issues.push({ kind: "pending_blobs", placeUrl: null, placeLabel: null, message: null });
  for (const p of enabled)
    if (p.freshness === "behind")
      issues.push({ kind: "behind", placeUrl: p.url, placeLabel: p.label, message: null });
  for (const p of enabled)
    if (p.freshness === "never")
      issues.push({ kind: "never_synced", placeUrl: p.url, placeLabel: p.label, message: null });
  for (const p of enabled)
    if (p.freshness === "stale")
      issues.push({ kind: "stale", placeUrl: p.url, placeLabel: p.label, message: null });
  const base = {
    places: 1 + current.length,
    pendingBlobCount: input.pendingBlobCount,
    pendingBlobBytes: input.pendingBlobBytes,
    pendingChanges,
    oldestSyncedAt: oldest,
    issues,
  };
  // Headline precedence: a FAILING target outranks in-flight/pending signals —
  // "still syncing" or "changes pending" must never mask a hard error.
  if (enabled.length === 0) return { state: "no_backup", ...base };
  if (enabled.some((p) => p.freshness === "error")) return { state: "peer_error", ...base };
  if (input.pendingBlobCount > 0) return { state: "pending_blobs", ...base };
  if (pendingChanges > 0) return { state: "unsynced_changes", ...base };
  if (enabled.some((p) => p.freshness === "never")) return { state: "syncing", ...base };
  if (enabled.some((p) => p.freshness === "stale")) return { state: "stale", ...base };
  return { state: "healthy", ...base };
}
