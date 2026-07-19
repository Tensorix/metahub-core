// Room-side protocol types and handlers for share-scoped rooms (Stage C).
// PORTABLE, driver-only — no node:/bun: imports — so the exact same handlers
// run under Bun for the in-process convergence tests (C1) and inside the
// Durable Object worker (C2) unchanged.
//
// A room is one share's always-on serving surface: its database is a plain
// core-schema hub (initSchema — the unused tables are empty and harmless)
// holding exactly one partition plus the guest ops authored in the room, with
// a small room_config side table (grants snapshot, guest base id, password
// verifier, expiry). The room holds ZERO outbound credentials — no master key,
// no bucket credentials — and never calls out; the owner drives every exchange
// through handleOwnerSync.
//
// Security invariants honored here (design.md §7):
//   - evict is LOCAL PHYSICAL DELETION and never produces an op (a tombstone
//     would flow back to the owner — deleting the owner's data);
//   - guest writes are intents; the ROOM stamps the HLC (its own persisted
//     clock, so a visitor's skewed/malicious clock never enters the oplog),
//     attributed to the visitor's per-session guest sub id;
//   - grants are parsed default-deny from the snapshot in room_config.

import type { DbDriver } from "../driver.ts";
import { MhError } from "../errors.ts";
import { ingest, CHANGE_COLS, type Change } from "../crdt.ts";
import { initSchema } from "../schema-init.ts";
import { randomSuffix } from "../ids.ts";
import { policyForRoom } from "../access-policy.ts";
import { applyGuestIntent, type GuestIntent } from "../guest-intent.ts";
import {
  intentReceiptCutoffHlc,
  INTENT_RECEIPT_DATASET,
} from "../intent-retention.ts";
import type { RecordRow } from "../records.ts";
import { allWinners, winnersDigest, PARTITION_DATASETS, type RowKey } from "./partition.ts";

export const ROOM_PROTOCOL_VERSION = 1;

export type ShareState = "active" | "expired";

/** Owner → room, one sync round. `changes` is the partition increment plus
 *  full-row winner baselines for rows that just entered (overlap is fine —
 *  the room oplog's UNIQUE dedups). `since` is the room-side seq cursor for
 *  the guest-op pull AND the ack that lets the room GC deferred guest oplog
 *  rows of evicted rows. `members`, when present, is the authoritative member
 *  key set (digest-mismatch reconciliation): the room locally deletes every
 *  partition row not listed. */
export interface OwnerSyncRequest {
  protocol: number;
  mh_version?: string;
  node_id: string;
  since: number;
  changes: Change[];
  evict: RowKey[];
  members?: RowKey[];
  digest?: string;
}

/** Room → owner. `changes` are guest-authored ops after `since` (never any
 *  other author), paged — `more` says the page was truncated and the owner
 *  should sync again promptly. `need_baseline` lists rows the room holds
 *  incompletely (orphaned by a shadow split) for the owner to re-judge.
 *  `need_blobs` lists site-file blob hashes the room lacks (chunked upload
 *  channel, /owner/blob). */
export interface OwnerSyncResponse {
  protocol: number;
  node_id: string;
  changes: Change[];
  cursor: number;
  /** The guest pull was truncated at the page limit — more rows are queued. */
  more?: boolean;
  need_baseline: RowKey[];
  need_blobs: string[];
  digest?: string;
  share_state: ShareState;
}

// ---- room provisioning -----------------------------------------------------------

/** Extra room-local tables on top of the core schema.
 *  - room_config: the provisioning snapshot (grants, guest base, pw verifier,
 *    expiry, state) — the room-side analogue of the owner's shares row.
 *  - evict_pending: rows evicted while still carrying guest oplog rows the
 *    owner hadn't acked; swept once `since` passes them (deferred GC). */
const ROOM_SCHEMA = `
CREATE TABLE IF NOT EXISTS room_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS evict_pending (
  dataset TEXT NOT NULL,
  row_id  TEXT NOT NULL,
  PRIMARY KEY (dataset, row_id)
);
CREATE TABLE IF NOT EXISTS room_blobs (
  hash  TEXT NOT NULL,
  idx   INTEGER NOT NULL,
  total INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (hash, idx)
);
`;

export interface RoomConfig {
  slug: string;
  /** The room's own node identity (meta.node_id) — clock owner, never an author. */
  roomNode: string;
  /** The share's base guest node id; per-visitor sub ids are `<base>-<rand6>`. */
  guestBase: string;
  /** Serialized GrantSet snapshot (read through parseGrantSet, default-deny). */
  grants: string;
  pwHash?: string | null;
  pwSalt?: string | null;
  expiresAt?: number | null;
  state: ShareState;
}

export interface RoomProvision {
  slug: string;
  guestBase: string;
  grants: string;
  pwHash?: string | null;
  pwSalt?: string | null;
  expiresAt?: number | null;
  /** Defaults to `room-<slug>`. */
  roomNode?: string;
}

/** Bring a fresh (or reopened) room database to shape and store its config.
 *  Idempotent; re-provisioning updates the config but keeps the node identity
 *  and clock (HLCs already issued must stay monotonic). */
export function initRoomDb(db: DbDriver, prov: RoomProvision): RoomConfig {
  initSchema(db);
  db.exec(ROOM_SCHEMA);
  const roomNode = prov.roomNode ?? `room-${prov.slug}`;
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?) ON CONFLICT(key) DO NOTHING").run(
    roomNode,
  );
  const cfg: RoomConfig = {
    slug: prov.slug,
    roomNode: (
      db.query("SELECT value FROM meta WHERE key = 'node_id'").get() as { value: string }
    ).value,
    guestBase: prov.guestBase,
    grants: prov.grants,
    pwHash: prov.pwHash ?? null,
    pwSalt: prov.pwSalt ?? null,
    expiresAt: prov.expiresAt ?? null,
    state: "active",
  };
  db.query(
    "INSERT INTO room_config (key, value) VALUES ('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(JSON.stringify(cfg));
  return cfg;
}

export function readRoomConfig(db: DbDriver): RoomConfig {
  const row = db.query("SELECT value FROM room_config WHERE key = 'config'").get() as
    | { value: string }
    | null;
  if (!row) throw new MhError("not_found", "room is not provisioned");
  return JSON.parse(row.value) as RoomConfig;
}

function writeRoomConfig(db: DbDriver, cfg: RoomConfig): void {
  db.query("UPDATE room_config SET value = ? WHERE key = 'config'").run(JSON.stringify(cfg));
}

/** Flip the share state (revocation propagates as "expired"; the physical
 *  destroy — DO deleteAll — is the C2 host's job). */
export function setRoomState(db: DbDriver, state: ShareState): void {
  const cfg = readRoomConfig(db);
  writeRoomConfig(db, { ...cfg, state });
}

/** Refresh the grants snapshot (owner re-granted; takes effect immediately
 *  for guest writes — pulls/pushes are unaffected, the owner re-scopes those). */
export function setRoomGrants(db: DbDriver, grants: string): void {
  const cfg = readRoomConfig(db);
  writeRoomConfig(db, { ...cfg, grants });
}

export function roomExpired(cfg: RoomConfig, now = Date.now()): boolean {
  return cfg.state === "expired" || (cfg.expiresAt != null && now > cfg.expiresAt);
}

// ---- site-file blob channel (C2) ----------------------------------------------------
// A site_files row with encoding='blob' stores only the content HASH — the
// bytes never ride the oplog. The room stores them chunked in room_blobs
// (chunks ≤1MiB, well under the DO 2MB row ceiling — spike ④); the owner pushes
// chunks for every hash the room reports in need_blobs.

/** Max hashes reported per sync round (the owner re-asks next round). */
const NEED_BLOBS_LIMIT = 32;
/** Chunk size cap enforced at the upload endpoint (DO row limit is ~2MB). */
export const ROOM_BLOB_CHUNK_LIMIT = 1024 * 1024;

/** Blob hashes referenced by live site_files rows with no complete chunk set. */
export function roomMissingBlobs(db: DbDriver, limit = NEED_BLOBS_LIMIT): string[] {
  const rows = db
    .query(
      `SELECT DISTINCT content AS hash FROM site_files
       WHERE encoding = 'blob' AND __deleted = 0 AND content IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM room_blobs b WHERE b.hash = site_files.content AND b.idx = 0
             AND (SELECT COUNT(*) FROM room_blobs c WHERE c.hash = b.hash) = b.total
         )
       ORDER BY hash LIMIT ?`,
    )
    .all(limit) as { hash: string }[];
  return rows.map((r) => r.hash);
}

/** Store one uploaded chunk. Chunk 0 resets the hash (a re-upload with a
 *  different chunking never leaves a stale mixed set behind). */
export function roomPutBlobChunk(
  db: DbDriver,
  hash: string,
  idx: number,
  total: number,
  bytes: Uint8Array,
): void {
  const tx = db.transaction(() => {
    if (idx === 0) db.query("DELETE FROM room_blobs WHERE hash = ?").run(hash);
    db.query(
      "INSERT OR REPLACE INTO room_blobs (hash, idx, total, bytes) VALUES (?, ?, ?, ?)",
    ).run(hash, idx, total, bytes);
  });
  tx();
}

/** Reassemble a blob's bytes, or null while the chunk set is incomplete. */
export function roomBlobBytes(db: DbDriver, hash: string): Uint8Array | null {
  const rows = db
    .query("SELECT idx, total, bytes FROM room_blobs WHERE hash = ? ORDER BY idx")
    .all(hash) as { idx: number; total: number; bytes: Uint8Array | ArrayBuffer }[];
  if (rows.length === 0 || rows.length !== rows[0]!.total) return null;
  const parts = rows.map((r) =>
    r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes),
  );
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** Drop chunk sets no live site_files row references (files deleted/evicted). */
function sweepRoomBlobs(db: DbDriver): void {
  db.query(
    `DELETE FROM room_blobs WHERE hash NOT IN (
       SELECT content FROM site_files WHERE encoding = 'blob' AND __deleted = 0 AND content IS NOT NULL
     )`,
  ).run();
}

// ---- guest-authorship predicate ----------------------------------------------------

/** SQL fragment matching guest-authored oplog rows (base id or `<base>-<sub>`).
 *  Binds two copies of the base id. Guest ids are base36 (`g` + randomSuffix),
 *  so no LIKE wildcard escaping is needed. */
const GUEST_NODE_SQL = "(node_id = ? OR node_id LIKE ? || '-%')";

function isGuestNode(base: string, node: string): boolean {
  return node === base || node.startsWith(base + "-");
}

// ---- owner sync ---------------------------------------------------------------------

const STATE_TABLE: Record<string, string> = Object.fromEntries(
  PARTITION_DATASETS.map((d) => [d, d]),
);

/**
 * Locally and physically delete one partition row: the materialized state row
 * plus its oplog rows — EXCEPT guest-authored ops the owner has not acked yet
 * (seq > ackSeq). Those are parked in evict_pending and swept once a later
 * round's `since` covers them, so an evict can never swallow an undelivered
 * guest write. NEVER emits an op (red line: a tombstone would replicate back
 * and delete the owner's data).
 */
function evictRow(db: DbDriver, key: RowKey, ackSeq: number, guestBase: string): void {
  const table = STATE_TABLE[key.dataset];
  if (!table) return;
  db.query(`DELETE FROM ${table} WHERE id = ?`).run(key.row_id);
  db.query(
    `DELETE FROM crdt_changes WHERE dataset = ? AND row_id = ?
     AND NOT (${GUEST_NODE_SQL} AND seq > ?)`,
  ).run(key.dataset, key.row_id, guestBase, guestBase, ackSeq);
  const remaining =
    db.query("SELECT 1 FROM crdt_changes WHERE dataset = ? AND row_id = ? LIMIT 1").get(
      key.dataset,
      key.row_id,
    ) != null;
  if (remaining)
    db.query("INSERT OR IGNORE INTO evict_pending (dataset, row_id) VALUES (?, ?)").run(
      key.dataset,
      key.row_id,
    );
  else db.query("DELETE FROM evict_pending WHERE dataset = ? AND row_id = ?").run(key.dataset, key.row_id);
}

/** Finish deferred evictions whose guest ops the owner has now acked. */
function sweepEvictPending(db: DbDriver, ackSeq: number, guestBase: string): void {
  const pending = db.query("SELECT dataset, row_id FROM evict_pending").all() as RowKey[];
  for (const k of pending) {
    const table = STATE_TABLE[k.dataset];
    // A row that has RE-ENTERED the partition (owner re-added it with a fresh,
    // higher-seq baseline — already ingested + materialized this round) is a
    // normal member again, not stale guest residue. Clear its marker and leave
    // the oplog alone. The old code assumed "everything here is guest-authored"
    // and its seq<=ackSeq delete would wipe the re-entry's OWNER baseline ops,
    // forking the room oplog from the owner until the next digest reconcile.
    if (table && db.query(`SELECT 1 FROM ${table} WHERE id = ? LIMIT 1`).get(k.row_id) != null) {
      db.query("DELETE FROM evict_pending WHERE dataset = ? AND row_id = ?").run(k.dataset, k.row_id);
      continue;
    }
    // Defense in depth: only guest-authored ops are ever eligible here (owner
    // baselines must survive) — mirror evictRow's own author predicate so the
    // invariant is enforced by SQL, not just by the assumption above.
    db.query(
      `DELETE FROM crdt_changes WHERE dataset = ? AND row_id = ? AND seq <= ? AND (${GUEST_NODE_SQL})`,
    ).run(k.dataset, k.row_id, ackSeq, guestBase, guestBase);
    const remaining =
      db.query("SELECT 1 FROM crdt_changes WHERE dataset = ? AND row_id = ? LIMIT 1").get(
        k.dataset,
        k.row_id,
      ) != null;
    if (!remaining)
      db.query("DELETE FROM evict_pending WHERE dataset = ? AND row_id = ?").run(k.dataset, k.row_id);
  }
}

/** Page budget for one round's guest pull (a weeks-offline owner facing very
 *  active guests must not get one giant response). */
const GUEST_PULL_LIMIT = 1000;

/** Guest-authored oplog changes after `seq`, plus the new cursor. Cursor
 *  semantics mirror partitionChangesAfterSeq: a truncated page stops the
 *  cursor at the last RETURNED row (`more: true` → the owner syncs again);
 *  an exhausted scan jumps to the table's high-water seq. */
function guestChangesAfterSeq(
  db: DbDriver,
  seq: number,
  guestBase: string,
  limit = GUEST_PULL_LIMIT,
): { changes: Change[]; cursor: number; more: boolean } {
  const rows = db
    .query(
      `SELECT seq AS __seq, ${CHANGE_COLS.join(", ")} FROM crdt_changes
       WHERE seq > ? AND ${GUEST_NODE_SQL}
         AND (dataset != ? OR hlc >= ?)
       ORDER BY seq LIMIT ?`,
    )
    .all(
      seq,
      guestBase,
      guestBase,
      INTENT_RECEIPT_DATASET,
      intentReceiptCutoffHlc(),
      limit,
    ) as (Change & { __seq: number })[];
  const more = rows.length >= limit;
  let cursor: number;
  if (more) {
    cursor = rows[rows.length - 1]!.__seq;
  } else {
    const top = db.query("SELECT MAX(seq) AS m FROM crdt_changes").get() as { m: number | null };
    cursor = Math.max(seq, top.m ?? seq);
  }
  return { changes: rows.map(({ __seq: _s, ...c }) => c), cursor, more };
}

/** Rows the room holds incompletely: a state row whose parent pointer never
 *  materialized (its baseline is missing — the shadow-split signature). The
 *  owner re-judges each against current membership. */
function orphanRows(db: DbDriver): RowKey[] {
  return db
    .query(
      `SELECT 'records' AS dataset, id AS row_id FROM records WHERE database_id IS NULL
       UNION ALL SELECT 'properties', id FROM properties WHERE database_id IS NULL
       UNION ALL SELECT 'site_files', id FROM site_files WHERE site_id IS NULL
       ORDER BY dataset, row_id`,
    )
    .all() as RowKey[];
}

/**
 * One owner sync round, room side. Order matters:
 *   1. ingest the owner's changes (idempotent — baseline/increment overlap and
 *      retried requests dedup on the oplog UNIQUE);
 *   2. compute the guest-op pull BEFORE any eviction GC, so an evict racing an
 *      undelivered guest op still delivers it this round;
 *   3. membership reset (when `members` rides along) then explicit evicts —
 *      local physical deletion, deferred for unacked guest ops;
 *   4. sweep deferred evictions now covered by `since`;
 *   5. orphan detection → need_baseline;
 *   6. digest, echoed only when the owner attached one (anti-entropy rounds).
 */
export function handleOwnerSync(
  roomDb: DbDriver,
  req: OwnerSyncRequest,
  cfg: RoomConfig = readRoomConfig(roomDb),
): OwnerSyncResponse {
  if (req.protocol !== ROOM_PROTOCOL_VERSION)
    throw new MhError(
      "conflict",
      `room speaks protocol ${ROOM_PROTOCOL_VERSION}, owner sent ${req.protocol} — upgrade required`,
    );
  if (roomExpired(cfg)) {
    return {
      protocol: ROOM_PROTOCOL_VERSION,
      node_id: cfg.roomNode,
      changes: [],
      cursor: req.since,
      need_baseline: [],
      need_blobs: [],
      share_state: "expired",
    };
  }

  const tx = roomDb.transaction((): OwnerSyncResponse => {
    ingest(roomDb, req.changes);

    const pull = guestChangesAfterSeq(roomDb, req.since, cfg.guestBase);

    if (req.members) {
      // Authoritative membership: locally delete every partition row not listed.
      const keep = new Set(req.members.map((k) => `${k.dataset} ${k.row_id}`));
      const held = roomDb
        .query(
          `SELECT DISTINCT dataset, row_id FROM crdt_changes
           WHERE dataset IN (${PARTITION_DATASETS.map(() => "?").join(", ")})`,
        )
        .all(...PARTITION_DATASETS) as RowKey[];
      for (const k of held) {
        if (!keep.has(`${k.dataset} ${k.row_id}`)) evictRow(roomDb, k, req.since, cfg.guestBase);
      }
    }

    for (const k of req.evict) evictRow(roomDb, k, req.since, cfg.guestBase);
    sweepEvictPending(roomDb, req.since, cfg.guestBase);
    sweepRoomBlobs(roomDb);

    return {
      protocol: ROOM_PROTOCOL_VERSION,
      node_id: cfg.roomNode,
      changes: pull.changes,
      cursor: pull.cursor,
      more: pull.more || undefined,
      need_baseline: orphanRows(roomDb),
      need_blobs: roomMissingBlobs(roomDb),
      digest: req.digest !== undefined ? winnersDigest(allWinners(roomDb)) : undefined,
      share_state: "active",
    };
  });
  return tx();
}

// ---- guest writes -------------------------------------------------------------------

/** A guest write intent (final decision 1: intents, not pre-signed ops — the
 *  room's clock is the time authority; the write shape mirrors share-serve).
 *  The wire form the room WS accepts; mapped to the shared GuestIntent in
 *  handleGuestWrite. `intentId`/`submittedAt` are optional (new SDK sends them
 *  for retry-idempotency; older clients omit and the server synthesizes). */
export interface GuestWriteIntent {
  op: "createRecord" | "updateRecord";
  /** Database ref (id or granted name) — createRecord. */
  db?: string;
  /** Record id — updateRecord (or client-minted id on createRecord). */
  record?: string;
  values: Record<string, unknown>;
  intentId?: string;
  submittedAt?: number;
}

export interface RoomGuestSession {
  /** Per-visitor guest sub id, minted at unlock (mintRoomGuestSub). */
  sub: string;
}

/** Mint a per-visitor guest sub id (`<base>-<rand6>`) — same shape as
 *  share-serve's session subs, so per-visitor rollback and the base-prefix
 *  bulk predicate work identically for room-authored writes. */
export function mintRoomGuestSub(cfg: RoomConfig): string {
  return `${cfg.guestBase}-${randomSuffix(6)}`;
}

/**
 * Apply one guest intent inside the room. Access gating (expiry + guest-node
 * validity) is enforced here; authorization, guardrails and the write itself go
 * through the shared applyGuestIntent executor (the same one the server share
 * endpoints and — from Stage 4 — drop replay use). Authority clock: the room's
 * persisted clock stamps the HLC, with the session's sub id as the author node.
 */
export function handleGuestWrite(
  roomDb: DbDriver,
  cfg: RoomConfig,
  session: RoomGuestSession,
  intent: GuestWriteIntent,
): RecordRow {
  if (roomExpired(cfg)) throw new MhError("auth", "unauthorized");
  if (!session.sub || !isGuestNode(cfg.guestBase, session.sub))
    throw new MhError("auth", "unauthorized");
  if (intent.op !== "createRecord" && intent.op !== "updateRecord")
    throw new MhError("invalid_input", `unknown intent op ${JSON.stringify((intent as { op?: unknown }).op)}`);
  const gi: GuestIntent = {
    intentId: intent.intentId || randomSuffix(16),
    action: intent.op,
    table: intent.db,
    recordId: intent.record,
    payload: intent.values,
    submittedAt: Number.isFinite(intent.submittedAt) ? intent.submittedAt! : Date.now(),
  };
  return applyGuestIntent(roomDb, policyForRoom(cfg), { guestNode: session.sub }, gi, { clock: "authority" });
}
