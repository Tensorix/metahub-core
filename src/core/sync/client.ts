import { editBases, ingestPeerChanges } from "./peer-v2.ts";
import { assertWorkspaceWritable, beginVersionCheck, dataVersionRange, localDataVersion, knownDataVersion, finishVersionCheck, observeDataVersion, requireSupportedVersion } from "./data-version.ts";
import { assertReplicaGeneration, readReplicaGeneration } from "./retention-protocol.ts";
import type { DbDriver } from "../driver.ts";
import { getNodeId } from "../node.ts";
import { changesAfterSeq, type Change } from "../crdt.ts";
import { type SyncResponse, SYNC_PATH } from "./protocol.ts";
import { MhError } from "../errors.ts";
import { withSyncBudget } from "./transport.ts";
import { classifyWorkspaceAccess, setWorkspaceAccess } from "./workspace-access.ts";

interface PeerCursors {
  pull_cursor: number;
  push_cursor: number;
  token: string | null;
}

function getPeer(db: DbDriver, url: string): PeerCursors {
  const row = db
    .query("SELECT pull_cursor, push_cursor, token FROM peers WHERE url = ?")
    .get(url) as PeerCursors | null;
  return row ?? { pull_cursor: 0, push_cursor: 0, token: null };
}

function setPeer(db: DbDriver, url: string, c: { pull_cursor: number; push_cursor: number }): void {
  db.query(
    "INSERT INTO peers (url, pull_cursor, push_cursor) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET pull_cursor = excluded.pull_cursor, push_cursor = excluded.push_cursor",
  ).run(url, c.pull_cursor, c.push_cursor);
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  /** Response page size (changes the peer returned this round), independent of
   *  how many were new to our oplog. Pagination must break on this, NOT on
   *  `pulled`: a page of all-known changes ingests 0 but may not be the last
   *  page (e.g. after a cursor reset re-pulls data we already hold). */
  received?: number;
  /** More local ops remain after this round. Drain bounded HTTP rounds while
   * this is true OR `received` fills the requested pull page. */
  pendingPush?: boolean;
  /** Storage transports set this when a bounded pull still has objects remaining. */
  pendingPull?: boolean;
  /** Non-fatal problems this round (e.g. clock-skew refusals in either direction). */
  warnings?: string[];
}

/** Human-readable warnings for changes refused as clock-skewed, per author node. */
export function skewWarnings(source: string, skewed: Record<string, number>): string[] {
  return Object.entries(skewed).map(
    ([node, n]) =>
      `${source}: refused ${n} change(s) from device ${node} stamped more than 5 min in the future — run \`mh repair --clock\` on that device`,
  );
}

export type SyncSynchronousPhase = "prepare" | "serialize" | "ingest" | "acknowledge";

export interface SyncOpts {
  /** Bearer credential; defaults to the one stored for this peer (pairing). */
  token?: string;
  /** Max changes to pull this round — chunked initial hydration. */
  pullLimit?: number;
  /** Max changes to push this round. Omit to preserve the full-push behavior. */
  pushLimit?: number;
  /** Datasets this replica opts out of (partial replica, e.g. site_files). */
  excludeDatasets?: string[];
  /** Hard transport budget. Every sync is bounded even when the peer accepts
   * the TCP connection but never replies. */
  timeoutMs?: number;
  /** Session-owned transport (for example a credential-scoped fetch). */
  fetch?: typeof fetch;
  /** Cancel an in-flight round when its session is disposed. */
  signal?: AbortSignal;
  /** Optional diagnostic wrapper. Invoke run exactly once synchronously and
   * preserve its result/error; no transport await occurs inside these phases. */
  measureSync?<T>(phase: SyncSynchronousPhase, run: () => T): T;
}

const changeKey = (c: Pick<Change, "hlc" | "node_id" | "dataset" | "row_id" | "col">): string =>
  `${c.hlc}\0${c.node_id}\0${c.dataset}\0${c.row_id}\0${c.col}`;

/** After a pull, advance the push cursor across the CONTIGUOUS prefix of
 * newly-appended oplog rows that came out of this round's response: the peer
 * obviously holds what it just sent us, so those rows must not count as
 * "unpushed" (they made status surfaces flash BEHIND after every successful
 * pull, until the next round skipped them). The walk stops at the first row
 * NOT in the response — e.g. a concurrent local write — which genuinely is
 * unpushed and must keep the peer looking behind. Exported for tests. */
export function advanceAckedPrefix(db: DbDriver, fromSeq: number, received: Change[]): number {
  if (received.length === 0) return fromSeq;
  const keys = new Set(received.map(changeKey));
  // A contiguous acknowledged prefix cannot contain more rows than the
  // response. Bound bridge work even when a large local upload queue remains.
  const rows = db
    .query(
      "SELECT rowid AS seq, hlc, node_id, dataset, row_id, col FROM crdt_changes WHERE rowid > ? ORDER BY rowid LIMIT ?",
    )
    .all(fromSeq, received.length) as (Pick<Change, "hlc" | "node_id" | "dataset" | "row_id" | "col"> & {
    seq: number;
  })[];
  let cursor = fromSeq;
  for (const row of rows) {
    if (!keys.has(changeKey(row))) break;
    cursor = row.seq;
  }
  return cursor;
}

/**
 * Run one push/pull round against a peer server. A single round is bidirectional
 * (pushes local changes, pulls remote ones). The token defaults to the credential
 * stored for this peer (set during pairing) and is sent as a Bearer header so a
 * token-gated /sync accepts the request.
 */
export async function syncWithPeer(
  db: DbDriver,
  url: string,
  opts: SyncOpts | string = {},
): Promise<SyncResult> {
  // Back-compat: the third parameter used to be the bare token string.
  const o: SyncOpts = typeof opts === "string" ? { token: opts } : opts;
  beginVersionCheck(db, url);
  const measure = o.measureSync ?? (<T>(_phase: SyncSynchronousPhase, run: () => T): T => run());
  const { node, peer, bearer, toPush } = measure("prepare", () => {
    const node = getNodeId(db);
    const peer = getPeer(db, url);
    const bearer = o.token ?? peer.token ?? undefined;
    if (o.pushLimit != null && (!Number.isSafeInteger(o.pushLimit) || o.pushLimit <= 0))
      throw new RangeError("sync pushLimit must be a positive integer");
    if (o.pullLimit != null && (!Number.isSafeInteger(o.pullLimit) || o.pullLimit <= 0))
      throw new RangeError("sync pullLimit must be a positive integer");
    const toPush = changesAfterSeq(db, peer.push_cursor, { limit: o.pushLimit });
    return { node, peer, bearer, toPush };
  });

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  requireSupportedVersion(localDataVersion(db));
  const generation = readReplicaGeneration(db);
  const joining = !!db.query("SELECT 1 FROM meta WHERE key='sync_version_pending_join' AND value=?").get(url);
  const checkVersion = (remote: { dataVersion?: number; generation?: unknown }) => {
    if (remote.dataVersion === undefined) return;
    const remoteId = (remote.generation as { workspaceId?: string })?.workspaceId;
    if (generation && remoteId && generation.workspaceId !== remoteId) throw new MhError("rebootstrap_required", "Peer workspace differs");
    if (typeof remoteId === "string" && remote.dataVersion >= 2 && (generation?.workspaceId === remoteId || (!generation && joining))) {
      if ((knownDataVersion(db)?.dataVersion ?? 1) > remote.dataVersion) throw new MhError("busy", "Peer data version moved backwards");
      observeDataVersion(db, remoteId, remote.dataVersion);
    }
    requireSupportedVersion(remote.dataVersion);
  };
  const data = await withSyncBudget(async (signal) => {
  {
    const health = await (o.fetch ?? fetch)(new URL("/health", url), { method: "GET", headers, signal });
    if (!health.ok) throw new MhError(health.status === 401 || health.status === 403 ? "auth" : "network", `sync preflight failed: ${health.status}`);
    const remote = await health.json() as { generation?: unknown; dataVersion?: number; capabilities?: string[] };
    if (signal.aborted) throw signal.reason;
    checkVersion(remote);
    if (remote.generation) {
      const { ReplicaGenerationSchema } = await import("./retention-protocol.ts");
      const state = classifyWorkspaceAccess(db, url, ReplicaGenerationSchema.parse(remote.generation), remote.dataVersion ?? 2, "http");
      if (!generation && !remote.capabilities?.includes("sync_bootstrap_v1")) {
        setWorkspaceAccess(db, { url, kind: "error", reason: "请更新服务器以支持新设备接入" });
        throw new MhError("busy", "请更新服务器以支持新设备接入");
      }
      setWorkspaceAccess(db, state);
      if (state.kind === "initializing") throw new MhError("busy", "正在初始化工作区，请稍候");
    }
    assertReplicaGeneration(db, remote.generation);
  }
  assertWorkspaceWritable(db);
  const res = await (o.fetch ?? fetch)(new URL(SYNC_PATH, url), {
    method: "POST",
    headers,
    body: measure("serialize", () => JSON.stringify({
      ...dataVersionRange, dataVersion: localDataVersion(db),
      ...(generation ? { generation, bases: editBases(db, toPush.changes) } : {}),
      node_id: node,
      since: peer.pull_cursor,
      changes: toPush.changes,
      ...(o.pullLimit != null ? { limit: o.pullLimit } : {}),
      ...(o.excludeDatasets?.length ? { exclude_datasets: o.excludeDatasets } : {}),
    })),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text();
    let reportedVersion: number | undefined;
    let reportedWorkspace: unknown;
    let protocolCode: "client_update_required" | "upgrade_required" | "rebootstrap_required" | "history_unavailable" | undefined;
    try {
      const body = JSON.parse(detail);
      if (body.code === "client_update_required" && Number.isSafeInteger(body.workspaceDataVersion)) {
        reportedVersion = body.workspaceDataVersion;
        reportedWorkspace = body.workspaceId;
      }
      if (body.code === "client_update_required" || body.code === "upgrade_required" || body.code === "rebootstrap_required" || body.code === "history_unavailable") protocolCode = body.code;
    } catch { /* Legacy endpoints may return plain text. */ }
    if (reportedVersion !== undefined) {
      if (signal.aborted) throw signal.reason;
      checkVersion({ dataVersion: reportedVersion, generation: { workspaceId: reportedWorkspace } });
    }
    throw new MhError(protocolCode ?? (res.status === 401 || res.status === 403 ? "auth" : "network"), `sync failed: ${res.status} ${detail}`);
  }

  return (await res.json()) as SyncResponse;
  }, o.timeoutMs, o.signal);
  // A disposed session must never write back cursors after transport completion.
  if (o.signal?.aborted) throw o.signal.reason ?? new Error("sync request aborted");
  checkVersion(data);
  assertReplicaGeneration(db, data.generation);
  finishVersionCheck(db, url);
  const changes = data.changes ?? [];
  // `pulled` = changes new to our oplog (ingest's return), not the response size,
  // so re-pulled-but-known data doesn't read as activity (consistent with the
  // storage path; keeps the auto-sync backoff honest). `received` carries the
  // response page size separately so paginated hydration can break on it.
  const r = measure("ingest", () => ingestPeerChanges(db, changes, data.bases));
  return measure("acknowledge", () => {
    const pulled = r.received;
    const pushCursor = advanceAckedPrefix(db, toPush.cursor, changes);
    setPeer(db, url, {
      pull_cursor: data.cursor,
      // Rows this round just ingested came FROM the peer — advance past them so
      // a successful pull never reads as "this peer is behind".
      push_cursor: pushCursor,
    });

    const warnings = skewWarnings(url, r.skewed);
    if (data.skewed_rejected)
      warnings.push(
        `${url} refused ${data.skewed_rejected} of this device's change(s) as stamped more than 5 min in the future — run \`mh repair --clock\` here`,
      );
    return {
      pushed: toPush.changes.length,
      pulled,
      received: changes.length,
      ...(o.pushLimit != null
        ? { pendingPush: changesAfterSeq(db, pushCursor, { limit: 1 }).changes.length > 0 }
        : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  });
}
