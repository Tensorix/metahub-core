// Owner-side room sync (Stage C): drives one share's partition into its room
// and pulls guest-authored ops back. Transport-agnostic — the actual wire
// (HTTP POST /r/<slug>/owner/sync with the owner secret, C2) is injected as a
// function, so the convergence tests call the room handler in-process.
//
// One round:
//   1. prepare, in one read transaction (consistent seq snapshot):
//      membership diff (entered/left vs the room_rows shadow), the shadow-
//      filtered oplog increment, winner baselines for entered rows (paged by
//      the same limit budget), the evict list;
//   2. send; on transport failure NOTHING was committed — cursors and shadow
//      are untouched, so the retry re-prepares the identical payload
//      (idempotent room-side via the oplog UNIQUE);
//   3. ingest the pulled guest ops (guarded: only guest-authored ops are
//      accepted from a room), then commit shadow + both cursors atomically;
//   4. answer need_baseline by re-judging each row against CURRENT membership
//      (member → baseline, not member → evict) in one follow-up call;
//   5. digest rounds (caller opts in — every ROOM_DIGEST_INTERVAL rounds or
//      after a grants change): on mismatch, full reconcile — all partition
//      winners plus the authoritative member key set.

import type { DbDriver } from "../driver.ts";
import { MhError } from "../errors.ts";
import { getNodeId } from "../node.ts";
import { ingest, type Change } from "../crdt.ts";
import {
  applyPartitionDiff,
  computePartitionMembers,
  isPartitionMember,
  partitionChangesAfterSeq,
  partitionDiff,
  partitionWinners,
  resetPartitionShadow,
  rowBaseline,
  winnersDigest,
  type PartitionDiff,
  type PartitionScope,
  type RowKey,
} from "./partition.ts";
import {
  ROOM_PROTOCOL_VERSION,
  type OwnerSyncRequest,
  type OwnerSyncResponse,
  type ShareState,
} from "./room-protocol.ts";

/** The wire. C2 wraps HTTP + Bearer ownerSecret; tests call handleOwnerSync. */
export type RoomTransport = (req: OwnerSyncRequest) => Promise<OwnerSyncResponse>;

export interface RoomClientConfig {
  /** peers.url of the kind='room' row (cursor storage), e.g. room://<slug>. */
  peerKey: string;
  /** The share's authorization closure — computed by the caller from the
   *  share row (grants + target site) each round, so re-grants apply next round. */
  scope: PartitionScope;
  /** The share's base guest node id — pulled ops must be authored under it,
   *  and owner pushes exclude it (no echo). */
  guestBase: string;
}

export interface RoomSyncOpts {
  /** Change budget per request (increment + baselines). Default 500. */
  limit?: number;
  /** Attach a digest this round (anti-entropy). The caller schedules these —
   *  every ROOM_DIGEST_INTERVAL rounds and after any grants change. */
  digest?: boolean;
  mhVersion?: string;
}

export interface RoomSyncResult {
  pushed: number;
  pulled: number;
  evicted: number;
  /** More increments/baselines are queued than the limit allowed — sync again. */
  pending: boolean;
  /** A digest mismatch triggered a full winners + member-set reconcile. */
  healed: boolean;
  /** Site-file blob hashes the room lacks — the caller pushes their bytes
   *  through the chunked /owner/blob channel (room-peer.ts). */
  needBlobs: string[];
  shareState: ShareState;
}

/** Send a digest every this many rounds (plus after any grants change). */
export const ROOM_DIGEST_INTERVAL = 16;

/** Ensure the peers row exists (kind='room', cursors at 0). The full config
 *  (base/slug/ownerSecret) is written by share-create --room (C2); tests and
 *  the client itself only need the cursor columns. */
export function ensureRoomPeer(db: DbDriver, peerKey: string): void {
  db.query(
    "INSERT INTO peers (url, kind, enabled, pull_cursor, push_cursor) VALUES (?, 'room', 1, 0, 0) ON CONFLICT(url) DO NOTHING",
  ).run(peerKey);
}

function readCursors(db: DbDriver, peerKey: string): { pull: number; push: number } {
  const row = db
    .query("SELECT pull_cursor, push_cursor FROM peers WHERE url = ?")
    .get(peerKey) as { pull_cursor: number; push_cursor: number } | null;
  return { pull: row?.pull_cursor ?? 0, push: row?.push_cursor ?? 0 };
}

function writeCursors(db: DbDriver, peerKey: string, cur: { pull: number; push: number }): void {
  db.query("UPDATE peers SET pull_cursor = ?, push_cursor = ? WHERE url = ?").run(
    cur.pull,
    cur.push,
    peerKey,
  );
}

/** Refuse anything a room returns that is not guest-authored: the room is a
 *  consent-scoped surface, never an author of owner data (defense in depth on
 *  top of the room's own onlyNode filter). */
function assertGuestAuthored(changes: Change[], guestBase: string): void {
  for (const c of changes) {
    if (c.node_id !== guestBase && !c.node_id.startsWith(guestBase + "-"))
      throw new MhError("auth", `room returned an op authored by ${JSON.stringify(c.node_id)} — refusing to ingest`);
  }
}

/** Distinct row keys of a pulled batch that are members under CURRENT state. */
function pulledMemberRows(db: DbDriver, cfg: RoomClientConfig, changes: Change[]): RowKey[] {
  const seen = new Set<string>();
  const out: RowKey[] = [];
  for (const c of changes) {
    const id = `${c.dataset} ${c.row_id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const key = { dataset: c.dataset, row_id: c.row_id };
    if (isPartitionMember(db, cfg.scope, key)) out.push(key);
  }
  return out;
}

interface Prepared {
  diff: PartitionDiff;
  shipped: RowKey[]; // the entered rows whose baselines fit this round
  changes: Change[];
  pushCursor: number;
  pendingBaselines: boolean;
  incrementFull: boolean;
}

/** Assemble one round's payload inside a single transaction (consistent seq
 *  window; the baseline/increment split at the snapshot seq leaves no gap and
 *  any overlap dedups room-side). Read-only w.r.t. the shadow and cursors. */
function prepareRound(db: DbDriver, cfg: RoomClientConfig, limit: number): Prepared {
  const tx = db.transaction((): Prepared => {
    const { push } = readCursors(db, cfg.peerKey);
    const diff = partitionDiff(db, cfg.peerKey, cfg.scope);
    const increment = partitionChangesAfterSeq(db, push, cfg.peerKey, {
      limit,
      excludeGuestBase: cfg.guestBase,
    });
    const changes: Change[] = [...increment.changes];
    const shipped: RowKey[] = [];
    for (const k of diff.entered) {
      if (changes.length >= limit && shipped.length > 0) break;
      changes.push(...rowBaseline(db, k.dataset, k.row_id));
      shipped.push(k);
      if (changes.length >= limit) break;
    }
    return {
      diff,
      shipped,
      changes,
      pushCursor: increment.cursor,
      pendingBaselines: shipped.length < diff.entered.length,
      incrementFull: increment.changes.length >= limit,
    };
  });
  return tx();
}

/**
 * One owner↔room sync round. Throws on transport/protocol errors (the caller —
 * peers-status bookkeeping in C2, tests here — records and retries; nothing
 * was committed, so a retry is a byte-identical resend). Returns pending:true
 * when the limit truncated the payload — loop until quiescent.
 */
export async function syncWithRoom(
  db: DbDriver,
  cfg: RoomClientConfig,
  transport: RoomTransport,
  opts: RoomSyncOpts = {},
): Promise<RoomSyncResult> {
  const limit = opts.limit ?? 500;
  ensureRoomPeer(db, cfg.peerKey);
  const since = readCursors(db, cfg.peerKey).pull;
  const prep = prepareRound(db, cfg, limit);

  const req: OwnerSyncRequest = {
    protocol: ROOM_PROTOCOL_VERSION,
    mh_version: opts.mhVersion,
    node_id: getNodeId(db),
    since,
    changes: prep.changes,
    evict: prep.diff.left,
    digest: opts.digest ? winnersDigest(partitionWinners(db, cfg.scope)) : undefined,
  };
  const resp = await transport(req);
  if (resp.protocol !== ROOM_PROTOCOL_VERSION)
    throw new MhError("conflict", `room answered protocol ${resp.protocol} — upgrade required`);
  if (resp.share_state === "expired") {
    // Revoked/expired share: nothing to commit; the caller tears the peer down (C2).
    return {
      pushed: 0,
      pulled: 0,
      evicted: 0,
      pending: false,
      healed: false,
      needBlobs: [],
      shareState: "expired",
    };
  }

  assertGuestAuthored(resp.changes, cfg.guestBase);
  const pulled = ingest(db, resp.changes);

  // The payload reached the room and its answer is ingested — now (and only
  // now) move the shadow and both cursors, atomically. Rows the pull touched
  // are room-authored, hence evidently room-held: they join the shadow too
  // (member ones — a row we are evicting this same round must not re-enter),
  // so a guest-created record is not re-baselined back at the room next round.
  db.transaction(() => {
    applyPartitionDiff(db, cfg.peerKey, {
      entered: [...prep.shipped, ...pulledMemberRows(db, cfg, resp.changes)],
      left: prep.diff.left,
    });
    writeCursors(db, cfg.peerKey, { pull: resp.cursor, push: prep.pushCursor });
  })();

  // Answer need_baseline: re-judge each row against CURRENT membership.
  if (resp.need_baseline.length > 0) await healBaselines(db, cfg, transport, resp.need_baseline);

  // Anti-entropy: compare the room's digest against our CURRENT partition
  // winners (recomputed after the pull so freshly ingested guest ops count).
  let healed = false;
  if (opts.digest && resp.digest !== undefined) {
    const mine = winnersDigest(partitionWinners(db, cfg.scope));
    if (mine !== resp.digest) {
      await fullReconcile(db, cfg, transport);
      healed = true;
    }
  }

  return {
    pushed: prep.changes.length,
    pulled,
    evicted: prep.diff.left.length,
    // Pending on either side: our push was truncated (limit) OR the room's
    // guest pull was (resp.more) — loop until quiescent either way.
    pending: prep.pendingBaselines || prep.incrementFull || resp.more === true,
    healed,
    needBlobs: resp.need_blobs ?? [],
    shareState: "active",
  };
}

/** Follow-up for the room's need_baseline list: rows still in the partition
 *  get their winner baseline (and join the shadow), rows that moved out get an
 *  evict (and leave the shadow). One call, no recursion — anything the room
 *  still reports next round is handled next round. */
async function healBaselines(
  db: DbDriver,
  cfg: RoomClientConfig,
  transport: RoomTransport,
  keys: RowKey[],
): Promise<void> {
  const changes: Change[] = [];
  const evict: RowKey[] = [];
  const entered: RowKey[] = [];
  for (const k of keys) {
    if (isPartitionMember(db, cfg.scope, k)) {
      changes.push(...rowBaseline(db, k.dataset, k.row_id));
      entered.push(k);
    } else {
      evict.push(k);
    }
  }
  const resp = await roundTrip(db, cfg, transport, changes, evict);
  if (resp.share_state === "expired") return;
  db.transaction(() => {
    applyPartitionDiff(db, cfg.peerKey, {
      entered: [...entered, ...pulledMemberRows(db, cfg, resp.changes)],
      left: evict,
    });
    const cur = readCursors(db, cfg.peerKey);
    writeCursors(db, cfg.peerKey, { pull: resp.cursor, push: cur.push });
  })();
}

/** Digest-mismatch repair: resend every partition winner plus the
 *  authoritative member key set; the room locally deletes anything not listed
 *  and the shadow is rebuilt to match. Winners ride unpaged — this is the rare
 *  recovery path (page it in C2 if real rooms ever make it hurt). */
async function fullReconcile(
  db: DbDriver,
  cfg: RoomClientConfig,
  transport: RoomTransport,
): Promise<void> {
  const members = computePartitionMembers(db, cfg.scope);
  const winners = partitionWinners(db, cfg.scope);
  const resp = await roundTrip(db, cfg, transport, winners, [], members);
  if (resp.share_state === "expired") return;
  db.transaction(() => {
    resetPartitionShadow(db, cfg.peerKey, members);
    const cur = readCursors(db, cfg.peerKey);
    writeCursors(db, cfg.peerKey, { pull: resp.cursor, push: cur.push });
  })();
}

/** Send one auxiliary request (heal/reconcile) and ingest its guest pull. */
async function roundTrip(
  db: DbDriver,
  cfg: RoomClientConfig,
  transport: RoomTransport,
  changes: Change[],
  evict: RowKey[],
  members?: RowKey[],
): Promise<OwnerSyncResponse> {
  const resp = await transport({
    protocol: ROOM_PROTOCOL_VERSION,
    node_id: getNodeId(db),
    since: readCursors(db, cfg.peerKey).pull,
    changes,
    evict,
    members,
  });
  if (resp.share_state === "expired") return resp;
  assertGuestAuthored(resp.changes, cfg.guestBase);
  ingest(db, resp.changes);
  return resp;
}
