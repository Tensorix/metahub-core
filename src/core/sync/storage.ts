// Storage-sync: use an S3-compatible bucket as dumb store-and-forward, so two
// devices sync without either running a publicly reachable server and without
// being online at the same time. The bucket only needs list/get/put/del — no
// metahub code runs there. This is a second transport behind the same peer
// model and the same CRDT primitives; core replication is unchanged.
//
// Each node publishes ONLY its own ops (crdt.ts changesAfterSeq onlyNode) under
// its own bucket prefix, as append-only segments. Pulling = list every other
// node's prefix, download new segments, ingest() them — order-independent and
// idempotent, so segments arriving out of order or twice converge regardless.
//
// Bucket layout (prefix = user-configured path within the bucket):
//   <prefix>/spaces/default/keys/main.json          E2EE: master key wrapped by passphrase
//   <prefix>/spaces/default/snapshot/<hlc>~<hash>.snap  winners-only baseline (any node publishes)
//   <prefix>/spaces/default/oplog/<node>/HEAD        latest segment key (cheap "anything new?" poll)
//   <prefix>/spaces/default/oplog/<node>/<seq>.seg   that node's ops, JSONL→gzip→AES-GCM
// The spaces/default/ level is reserved now so future per-space sharing needs
// no storage migration.

import type { DbDriver } from "../driver.ts";
import { getNodeId } from "../node.ts";
import { changesAfterSeq, ingest, CHANGE_SELECT, type Change } from "../crdt.ts";
import { isElectedPublisher } from "./publisher-lease.ts";
import { MhError, errorCode } from "../errors.ts";
import type { SyncResult } from "./client.ts";
import {
  encryptBytes,
  decryptBytes,
  generateMasterKey,
  wrapMasterKey,
  unwrapMasterKey,
  toB64,
  fromB64,
  type KeyEnvelope,
} from "./e2ee.ts";

// ---- config + client surface ---------------------------------------------------

/** An 's3' peer's bucket settings, stored as JSON in peers.config (local-only). */
export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** When false (`--no-encrypt`) segments are gzip-only plaintext. */
  encrypt: boolean;
  /** base64 raw 32-byte master key; present iff encrypt. Resolved at peer-add. */
  masterKey?: string;
  /**
   * Address objects as `<bucket>.<host>/<key>` (virtual-hosted) instead of
   * `<host>/<bucket>/<key>` (path-style). Some providers (Tencent COS) reject
   * path-style outright. When undefined, the clients auto-detect: virtual-hosted
   * iff the endpoint host already starts with `<bucket>.` (see
   * isVirtualHostedStyle). R2/MinIO keep using path-style.
   */
  virtualHostedStyle?: boolean;
  /**
   * Node-role hints for this bucket (not bucket settings — safe to omit from
   * shared enroll links). `publish` marks this node as the bucket's publisher
   * (writes whole-hub snapshots; see StorageSyncOpts.publish): true for the data
   * home (a server, or a no-origin PWA which IS the home), false for a replica
   * that only attaches the bucket for its own away-sync. `priority` ranks
   * publisher candidates when several are eligible (higher wins; see
   * publisher-lease.ts) — server > desktop > laptop > phone.
   */
  publish?: boolean;
  priority?: number;
}

/** Whether to use virtual-hosted addressing for this bucket: the explicit flag,
 *  or — when unset — auto-detected from an endpoint whose host already carries
 *  the bucket (e.g. COS's `<bucket>.cos.<region>.myqcloud.com`). */
export function isVirtualHostedStyle(config: S3Config): boolean {
  if (config.virtualHostedStyle != null) return config.virtualHostedStyle;
  try {
    return new URL(config.endpoint).hostname.startsWith(`${config.bucket}.`);
  } catch {
    return false;
  }
}

export interface StorageObject {
  key: string;
  etag?: string;
}

/** Options for a conditional/typed put. */
export interface StoragePutOpts {
  contentType?: string;
  /** Conditional create (S3 `If-None-Match: *`): fail with an MhError("conflict")
   *  if the object already exists. Used to make first-time key provisioning a
   *  compare-and-set so two devices initializing the same empty bucket can't
   *  clobber each other's master key. */
  ifNoneMatch?: boolean;
}

/** The minimal object-store surface storage-sync needs. Implemented per runtime:
 *  Bun.S3Client on the CLI/desktop (storage-s3-bun.ts), aws4fetch SigV4 + fetch
 *  in the browser worker (webui/data/storage-s3-browser.ts). */
export interface StorageClient {
  /** Keys under `prefix`, ascending, optionally only those strictly after
   *  `startAfter`. With `delimiter` ("/"), collapse one level into common
   *  prefixes (their keys end in the delimiter) to discover child "folders"
   *  cheaply — callers must tolerate a backend that ignores it and returns full
   *  keys instead. */
  list(prefix: string, startAfter?: string, delimiter?: string): Promise<StorageObject[]>;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array, opts?: StoragePutOpts): Promise<void>;
  del(key: string): Promise<void>;
}

type StorageClientFactory = (config: S3Config) => StorageClient;
let factory: StorageClientFactory | null = null;

/** Register this runtime's S3 client builder (see the per-runtime impls). */
export function setStorageClientFactory(f: StorageClientFactory): void {
  factory = f;
}

export function storageClientFor(config: S3Config): StorageClient {
  if (!factory)
    throw new MhError("network", "no S3 storage client is registered for this runtime");
  return factory(config);
}

// ---- bucket key layout ----------------------------------------------------------

/** Reserved cursor key for "which snapshots have we already ingested". Real node
 *  ids are 8-char random suffixes, so this sentinel can't collide with one. */
const SNAPSHOT_CURSOR = "__snapshot__";
const SEG_PAD = 16;
/** Separator between the snapshot's max-HLC and its content hash in the object
 *  key. Must not appear in an HLC (which is digits + '-'); '~' sorts above every
 *  HLC char so keys still order by max-HLC then hash. */
const SNAP_SEP = "~";

// ---- snapshot/truncation policy defaults (log-structured; see ⑤) ----------------
/** Keep this many of our most recent own segments alive past a snapshot so a
 *  consumer behind by < a window catches up incrementally instead of re-pulling
 *  the whole-hub snapshot. Older segments are truncated → bucket stays bounded. */
const DEFAULT_RETAIN_SEGMENTS = 40;
/** Publish a new snapshot once the whole-hub delta since the newest snapshot
 *  reaches max(MIN_DELTA ops, hub_size × DELTA_RATIO) — a checkpoint that "pays
 *  for itself", instead of a short wall-clock timer that re-checkpoints every 60s
 *  and strands consumers on full downloads. */
const DEFAULT_SNAPSHOT_MIN_DELTA = 200;
const DEFAULT_SNAPSHOT_DELTA_RATIO = 0.5;
/** Safety cap: publish anyway if the hub advanced and this long passed since the
 *  newest snapshot, so a slow trickle of edits still gets a fresh baseline. */
const DEFAULT_SNAPSHOT_MAX_INTERVAL_MS = 30 * 60_000;

function basePrefix(prefix: string): string {
  const p = (prefix || "").replace(/^\/+|\/+$/g, "");
  return p ? `${p}/spaces/default` : "spaces/default";
}
const oplogRoot = (base: string) => `${base}/oplog/`;
const nodePrefix = (base: string, node: string) => `${base}/oplog/${node}/`;
const headKey = (base: string, node: string) => `${base}/oplog/${node}/HEAD`;
const segKey = (base: string, node: string, seq: number) =>
  `${base}/oplog/${node}/${String(seq).padStart(SEG_PAD, "0")}.seg`;
const snapshotRoot = (base: string) => `${base}/snapshot/`;
const mainKeyPath = (base: string) => `${base}/keys/main.json`;

// ---- segment codec (Change[] ⇄ bytes) -------------------------------------------

// new Response(bytes) wants BodyInit; TS 5.7's Uint8Array<ArrayBufferLike> isn't
// seen as one. The bytes are always ArrayBuffer-backed, so the cast is sound.
const body = (u: Uint8Array): BodyInit => u as unknown as BodyInit;

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(body(bytes)).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(body(bytes)).body!.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Serialize changes to the canonical JSONL the segment/snapshot codec stores. */
function toJsonl(changes: Change[]): string {
  return changes.map((c) => JSON.stringify(c)).join("\n");
}

async function encodeSegment(changes: Change[], key: Uint8Array | null): Promise<Uint8Array> {
  const gz = await gzip(new TextEncoder().encode(toJsonl(changes)));
  return key ? encryptBytes(key, gz) : gz;
}

async function decodeSegment(bytes: Uint8Array, key: Uint8Array | null): Promise<Change[]> {
  const gz = key ? await decryptBytes(key, bytes) : bytes;
  const jsonl = new TextDecoder().decode(await gunzip(gz));
  if (!jsonl) return [];
  return jsonl
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Change);
}

function masterKeyOf(config: S3Config): Uint8Array | null {
  return config.encrypt && config.masterKey ? fromB64(config.masterKey) : null;
}

/** Short content hash (hex) for snapshot keying — runtime-agnostic (WebCrypto). */
async function contentHash(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s) as unknown as BufferSource,
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// ---- cursors --------------------------------------------------------------------

function getPushCursor(db: DbDriver, url: string): number {
  const r = db.query("SELECT push_cursor FROM peers WHERE url = ?").get(url) as
    | { push_cursor: number }
    | null;
  return r?.push_cursor ?? 0;
}
function setPushCursor(db: DbDriver, url: string, c: number): void {
  db.query("UPDATE peers SET push_cursor = ? WHERE url = ?").run(c, url);
}
function getStorageCursor(db: DbDriver, url: string, node: string): string | null {
  const r = db
    .query("SELECT last_key FROM storage_cursors WHERE peer_url = ? AND node_id = ?")
    .get(url, node) as { last_key: string | null } | null;
  return r?.last_key ?? null;
}
function setStorageCursor(db: DbDriver, url: string, node: string, key: string): void {
  db.query(
    "INSERT INTO storage_cursors (peer_url, node_id, last_key) VALUES (?, ?, ?) " +
      "ON CONFLICT(peer_url, node_id) DO UPDATE SET last_key = excluded.last_key",
  ).run(url, node, key);
}

/** Snapshot keys we've already ingested for this peer (newline-joined set in the
 *  SNAPSHOT_CURSOR sentinel row). A set, not a single "latest" key: two nodes
 *  can publish different-content snapshots at the same max-HLC, and a single
 *  lexicographic cursor would skip one of them. */
function getSnapshotConsumed(db: DbDriver, url: string): Set<string> {
  const raw = getStorageCursor(db, url, SNAPSHOT_CURSOR);
  return new Set(raw ? raw.split("\n").filter(Boolean) : []);
}
function setSnapshotConsumed(db: DbDriver, url: string, keys: Iterable<string>): void {
  setStorageCursor(db, url, SNAPSHOT_CURSOR, [...keys].join("\n"));
}

// ---- winners snapshot -----------------------------------------------------------

/** The current winner (max-HLC row) of every register — the head state as oplog
 *  rows. Mirrors compact.ts's "collapse to as-of-cutoff winner": a consumer that
 *  ingests this reaches the same materialized state. Tombstone winners included. */
function winnersSnapshot(db: DbDriver): Change[] {
  return db
    .query(
      `SELECT ${CHANGE_SELECT} FROM crdt_changes c
       WHERE NOT EXISTS (
         SELECT 1 FROM crdt_changes k
         WHERE k.dataset = c.dataset AND k.row_id = c.row_id AND k.col = c.col AND k.hlc > c.hlc
       )`,
    )
    .all() as Change[];
}

// ---- snapshot frontier (vector clock) for incremental skip -----------------------

/** Per-node HLC frontier: node_id → max HLC reflected for that node. A consumer
 *  whose own frontier dominates a snapshot's already holds every winner in it. */
type Frontier = Record<string, string>;

/** Frontier of a winner set: per author node, the max winner HLC. */
function frontierOfWinners(winners: Change[]): Frontier {
  const f: Frontier = {};
  for (const c of winners) if (!f[c.node_id] || c.hlc > f[c.node_id]!) f[c.node_id] = c.hlc;
  return f;
}

/** This node's local frontier from its oplog (per node, max ingested HLC). Cheap
 *  GROUP BY; segments are pulled gap-free per node so this is a true prefix. */
function localFrontier(db: DbDriver): Frontier {
  const rows = db
    .query("SELECT node_id, MAX(hlc) AS h FROM crdt_changes GROUP BY node_id")
    .all() as { node_id: string; h: string }[];
  const f: Frontier = {};
  for (const r of rows) f[r.node_id] = r.h;
  return f;
}

/** True when `local` already covers every node frontier in `snap` (∀ node n:
 *  local[n] ≥ snap[n]). Then ingesting the snapshot would add nothing → skip it. */
function dominates(local: Frontier, snap: Frontier): boolean {
  for (const n in snap) if (!local[n] || local[n]! < snap[n]!) return false;
  return true;
}

/** Sidecar object carrying a snapshot's frontier so a caught-up consumer can skip
 *  the (whole-hub) body GET, plus the publisher's own latest seg key at snapshot
 *  time so a consumer that DID ingest the snapshot can advance its cursor past the
 *  publisher's retained segments (⑤c) instead of re-pulling them. */
interface SnapMeta {
  frontier: Frontier;
  ownNode: string;
  ownSegHigh: string | null;
}
const vcKey = (snapKey: string) => `${snapKey}.vc`;

async function encodeVc(meta: SnapMeta, key: Uint8Array | null): Promise<Uint8Array> {
  const gz = await gzip(new TextEncoder().encode(JSON.stringify(meta)));
  return key ? encryptBytes(key, gz) : gz;
}
async function decodeVc(bytes: Uint8Array, key: Uint8Array | null): Promise<SnapMeta | null> {
  try {
    const gz = key ? await decryptBytes(key, bytes) : bytes;
    return JSON.parse(new TextDecoder().decode(await gunzip(gz))) as SnapMeta;
  } catch {
    return null; // unreadable/legacy snapshot with no .vc → caller falls back to GET
  }
}

// ---- node-prefix discovery ------------------------------------------------------

function nodesFromKeys(objs: StorageObject[], root: string): string[] {
  const nodes = new Set<string>();
  for (const o of objs) {
    const rest = o.key.slice(root.length); // "<node>/" (delimiter) or "<node>/<file>"
    const slash = rest.indexOf("/");
    if (slash > 0) nodes.add(rest.slice(0, slash));
  }
  return [...nodes];
}

/** Discover the node prefixes under oplog/. Asks for a delimited (one-level)
 *  listing so a backend that honors it returns just the "<node>/" folders
 *  instead of every segment; nodesFromKeys derives the same node set whether the
 *  backend collapsed them or returned full keys. */
async function listRemoteNodes(client: StorageClient, base: string): Promise<string[]> {
  const root = oplogRoot(base);
  return nodesFromKeys(await client.list(root, undefined, "/"), root);
}

// ---- master-key provisioning (peer-add time) ------------------------------------

/**
 * Resolve the master key for a bucket at setup: read keys/main.json and unwrap
 * with the passphrase, or — when absent — generate a key, wrap it, and upload
 * it with `If-None-Match` so a concurrent first-time init can't clobber it.
 * Returns base64(K) to store in peers.config, or null when encryption is off.
 * Wrong passphrase throws `auth` (from unwrapMasterKey).
 */
export async function provisionMasterKey(
  client: StorageClient,
  config: S3Config,
  passphrase: string,
): Promise<string | null> {
  if (!config.encrypt) return null;
  const base = basePrefix(config.prefix);
  const path = mainKeyPath(base);
  const unwrap = async (bytes: Uint8Array) =>
    toB64(await unwrapMasterKey(JSON.parse(new TextDecoder().decode(bytes)) as KeyEnvelope, passphrase));

  const existing = await client.get(path);
  if (existing) return unwrap(existing);

  const K = generateMasterKey();
  const env = await wrapMasterKey(K, passphrase);
  try {
    await client.put(path, new TextEncoder().encode(JSON.stringify(env)), {
      contentType: "application/json",
      ifNoneMatch: true,
    });
    return toB64(K);
  } catch (e) {
    // Lost a first-init race: another device created the key between our GET and
    // PUT. Adopt theirs (unwraps with the same passphrase, or fails `auth`).
    if (errorCode(e) === "conflict") {
      const winner = await client.get(path);
      if (winner) return unwrap(winner);
    }
    throw e;
  }
}

// ---- snapshot publish + truncation ----------------------------------------------

/**
 * Publish a winners-only snapshot and truncate this node's own segments. Every
 * op we've uploaded so far is in the local oplog now, so the snapshot (winners
 * as-of the current max HLC) supersedes all of them — they're safe to delete
 * (compact.ts invariant #1). Ops produced afterwards go into fresh, higher-keyed
 * segments; consumers reach our pre-snapshot state via the snapshot itself.
 *
 * The key is `<maxHlc>~<hash>.snap`: the hash (over the canonical winner set)
 * makes converged nodes collide on one key (deduped) while two nodes that are
 * NOT converged — same max HLC but different extra winners — get distinct keys,
 * so neither overwrites the other. Then old snapshots (strictly lower max-HLC)
 * are GC'd so the bucket stays bounded.
 *
 * Returns the snapshot key + change count, or null when the oplog is empty.
 */
export async function publishSnapshot(
  db: DbDriver,
  client: StorageClient,
  config: S3Config,
  retainSegments: number = DEFAULT_RETAIN_SEGMENTS,
): Promise<{ key: string; changes: number } | null> {
  const key = masterKeyOf(config);
  const base = basePrefix(config.prefix);
  const winners = winnersSnapshot(db);
  if (winners.length === 0) return null;
  const node = getNodeId(db);
  const maxHlc = winners.reduce((m, c) => (c.hlc > m ? c.hlc : m), "");
  // Hash a deterministic (sorted) view so row order can't change the key.
  const hash = await contentHash(winners.map((c) => JSON.stringify(c)).sort().join("\n"));
  const snapKey = `${snapshotRoot(base)}${maxHlc}${SNAP_SEP}${hash}.snap`;

  // Our own segments present right now are all covered by this snapshot (winners
  // of the same DB state). The highest is the cursor a consumer can jump to after
  // ingesting the snapshot, so it won't re-pull the segments we retain below.
  const ownSegs = (await client.list(nodePrefix(base, node)))
    .map((o) => o.key)
    .filter((k) => k.endsWith(".seg"))
    .sort();
  const ownSegHigh = ownSegs.length ? ownSegs[ownSegs.length - 1]! : null;

  await client.put(snapKey, await encodeSegment(winners, key), {
    contentType: "application/octet-stream",
  });
  // Frontier sidecar (⑤b): pullSnapshots reads it to skip the whole-hub body GET
  // when already caught up, and to advance its cursor past our retained segments.
  await client.put(
    vcKey(snapKey),
    await encodeVc({ frontier: frontierOfWinners(winners), ownNode: node, ownSegHigh }, key),
    { contentType: "application/octet-stream" },
  );

  // GC: drop snapshots (and their .vc) from a strictly older frontier (keep this
  // max-HLC and any concurrent sibling/newer one). maxHlc is fixed width, so a
  // basename compare before SNAP_SEP is the max-HLC compare.
  for (const o of await client.list(snapshotRoot(base))) {
    if (!o.key.endsWith(".snap")) continue;
    const mh = o.key.slice(snapshotRoot(base).length).split(SNAP_SEP)[0]!;
    if (mh < maxHlc) {
      await client.del(o.key);
      await client.del(vcKey(o.key));
    }
  }

  // Truncate our own superseded segments but RETAIN the most recent
  // `retainSegments` (⑤c): a consumer behind by < a window catches up via segments
  // (incremental) instead of re-downloading the whole-hub snapshot.
  const toDelete = ownSegs.slice(0, Math.max(0, ownSegs.length - retainSegments));
  for (const k of toDelete) await client.del(k);
  return { key: snapKey, changes: winners.length };
}

// ---- one sync round -------------------------------------------------------------

export interface StorageSyncOpts {
  /** Publish a snapshot + truncate once this node's own segment count reaches
   *  this. Default 200 — high enough that typical use rarely hits it, low enough
   *  to keep the bucket bounded under heavy use. */
  snapshotEverySegments?: number;
  /** Push-batching: defer uploading our pending own ops until there are at least
   *  this many (default 1 → push every round). Coalesces a burst of edits into
   *  one segment instead of many tiny ones (each is a billed request + a GET for
   *  every puller). */
  minPushChanges?: number;
  /** …or until the oldest pending op is at least this old (ms; default 0 → no
   *  age bound). Bounds how long a small trailing edit waits. */
  maxPushAgeMs?: number;
  /** Push regardless of the batching thresholds — use on explicit "sync now" and
   *  when the app is backgrounding, so edits are never stranded unsynced. */
  forcePush?: boolean;
  /**
   * This node is the bucket's *publisher*: keep the bucket a complete, fresh
   * whole-hub mirror by writing a winners-only snapshot (publishSnapshot) when
   * the bucket has none yet, or when the hub has advanced past the newest
   * snapshot. The snapshot spans the WHOLE db, so it captures data authored by
   * nodes that never push to this bucket themselves (e.g. a server holding the
   * canonical hub while browsers only window onto it) — fixing the "attached a
   * bucket but it stays empty" footgun. Any node holding the full hub can be the
   * publisher; who is one is decided above storage.ts (server by default, else a
   * lease — see publisher-lease.ts). Correctness never depends on a single
   * publisher: concurrent snapshots are content-addressed and idempotent. */
  publish?: boolean;
  /** ⑤d snapshot trigger: publish once the whole-hub delta since the newest
   *  snapshot reaches max(`snapshotMinDelta` ops, hub_size × `snapshotDeltaRatio`),
   *  or `snapshotMaxIntervalMs` elapsed (safety). Replaces the old 60s timer that
   *  re-checkpointed constantly and forced full re-downloads. Defaults:
   *  DEFAULT_SNAPSHOT_MIN_DELTA / _DELTA_RATIO / _MAX_INTERVAL_MS. */
  snapshotMinDelta?: number;
  snapshotDeltaRatio?: number;
  snapshotMaxIntervalMs?: number;
  /** ⑤c: keep this many of our most recent own segments alive past a snapshot so
   *  slightly-behind consumers catch up incrementally (default DEFAULT_RETAIN_SEGMENTS). */
  snapshotRetainSegments?: number;
  /** This node's publisher priority when contending for the lease (higher wins;
   *  see publisher-lease.ts). Only consulted when `publish` is set. */
  priority?: number;
  /**
   * Run the PULL half of the round (snapshots + other nodes' segments). Default
   * true. Set false for *push-only* rounds: an origin-backed replica gets a
   * superset of bucket contents from its origin (HTTP), so it never needs to PULL
   * the bucket — it only PUSHes its own segments here for independent durability
   * (Path B). Skipping PULL drops the two unconditional LISTs (snapshot/, oplog/)
   * that dominate idle bucket cost. A *publisher* must always PULL (it needs the
   * snapshot list to decide what to publish), so callers never combine
   * `publish:true` with `pull:false`.
   */
  pull?: boolean;
}

/** Epoch millis encoded in an HLC's first 15 chars (hlc.ts formatHlc). */
function hlcMs(hlc: string): number {
  return parseInt(hlc.slice(0, 15), 10);
}

/** Wall-clock age (ms) of a change from its HLC. */
function changeAgeMs(c: Change): number {
  return Date.now() - hlcMs(c.hlc);
}

/** The max-HLC of the newest snapshot present in the bucket, or null when none.
 *  Parsed from the `<maxHlc>~<hash>.snap` key, so it needs no GET. */
function newestSnapshotHlc(snapKeys: string[], base: string): string | null {
  const root = snapshotRoot(base);
  let max: string | null = null;
  for (const k of snapKeys) {
    const mh = k.slice(root.length).split(SNAP_SEP)[0]!;
    if (max === null || mh > max) max = mh;
  }
  return max;
}

/**
 * One push/pull round against a storage peer. Push uploads this node's pending
 * own ops as a new segment (subject to batching); pull hydrates from snapshots
 * (any not yet ingested) then drains each other node's new segments. Returns
 * { pushed, pulled } like syncWithPeer so peers.ts status writeback is shared.
 */
export async function syncWithStorage(
  db: DbDriver,
  peerUrl: string,
  client: StorageClient,
  config: S3Config,
  opts: StorageSyncOpts = {},
): Promise<SyncResult> {
  const node = getNodeId(db);
  const key = masterKeyOf(config);
  const base = basePrefix(config.prefix);

  // PUSH: our own un-uploaded ops → one new segment + HEAD pointer.
  const pushCursor = getPushCursor(db, peerUrl);
  const batch = changesAfterSeq(db, pushCursor, { onlyNode: node });
  let pushed = 0;
  if (batch.changes.length === 0) {
    // No own ops pending: still advance past any ingested foreign rows so they
    // aren't rescanned every round (changesAfterSeq's high-water on exhaustion).
    setPushCursor(db, peerUrl, batch.cursor);
  } else {
    const minChanges = opts.minPushChanges ?? 1;
    const maxAge = opts.maxPushAgeMs ?? 0;
    const ready =
      opts.forcePush || batch.changes.length >= minChanges || changeAgeMs(batch.changes[0]!) >= maxAge;
    if (ready) {
      // Write HEAD *before* the segment: a crash between the two then leaves HEAD
      // pointing at a not-yet-present key, which only makes a puller LIST once
      // more (safe) — the reverse order could leave HEAD behind a written
      // segment and make the cheap-skip below silently miss it.
      const k = segKey(base, node, batch.cursor);
      await client.put(headKey(base, node), new TextEncoder().encode(k), {
        contentType: "text/plain",
      });
      await client.put(k, await encodeSegment(batch.changes, key), {
        contentType: "application/octet-stream",
      });
      setPushCursor(db, peerUrl, batch.cursor);
      pushed = batch.changes.length;
    }
    // else: pending but below threshold → leave the cursor, retry next round.
  }

  // PULL: snapshots first (every one we haven't ingested)…then each other node's
  // new segments. Skipped entirely in push-only mode (opts.pull === false) — see
  // StorageSyncOpts.pull. `snapKeys` stays [] then; the PUBLISHER block below only
  // runs when opts.publish, and a publisher always pulls, so it never sees [].
  let snapKeys: string[] = [];
  let pulled = 0;
  if (opts.pull ?? true) {
    snapKeys = (await client.list(snapshotRoot(base)))
      .map((o) => o.key)
      .filter((k) => k.endsWith(".snap"));
    pulled += await pullSnapshots(db, peerUrl, snapKeys, client, key);

    // …then each other node's new segments.
    for (const remote of await listRemoteNodes(client, base)) {
      if (remote === node) continue; // never pull our own prefix back in
      const cursor = getStorageCursor(db, peerUrl, remote);
      // Cheap skip: HEAD names the latest segment key; if we're already at/after
      // it there's nothing new. HEAD is written before its segment, so it's never
      // behind the real latest — this can't skip a present-but-newer segment.
      const head = await client.get(headKey(base, remote));
      if (head) {
        const latest = new TextDecoder().decode(head);
        if (cursor && latest <= cursor) continue;
      }
      const segs = (await client.list(nodePrefix(base, remote), cursor ?? undefined)).filter(
        (o) => o.key.endsWith(".seg"),
      );
      for (const seg of segs) {
        const bytes = await client.get(seg.key);
        if (!bytes) continue;
        const changes = await decodeSegment(bytes, key);
        ingest(db, changes);
        pulled += changes.length;
        setStorageCursor(db, peerUrl, remote, seg.key);
      }
    }
  }

  // PUBLISHER: keep the bucket a complete, fresh whole-hub mirror. The snapshot
  // spans the whole db, so it carries data authored by nodes that never push
  // here — and an empty bucket gets its first snapshot immediately (the
  // "attached but empty" fix). Rate-limited so a steady edit stream doesn't
  // snapshot every round; `snapKeys` was already listed above, so no extra LIST.
  let didSnapshot = false;
  if (opts.publish) {
    const hubSize = (db.query("SELECT COUNT(*) AS n FROM crdt_changes").get() as { n: number }).n;
    if (hubSize > 0) {
      const newest = newestSnapshotHlc(snapKeys, base);
      // ⑤d: checkpoint when the whole-hub delta since the newest snapshot is worth
      // a fresh baseline — max(min ops, hub_size × ratio) — or a safety time cap.
      // Local-only queries; no extra bucket calls. (⑤a: forcePush no longer forces
      // a snapshot — it only forces the PUSH above — so a steady "sync now" / user
      // refresh can't trigger whole-hub re-publishes.)
      const minDelta = opts.snapshotMinDelta ?? DEFAULT_SNAPSHOT_MIN_DELTA;
      const ratio = opts.snapshotDeltaRatio ?? DEFAULT_SNAPSHOT_DELTA_RATIO;
      const maxInterval = opts.snapshotMaxIntervalMs ?? DEFAULT_SNAPSHOT_MAX_INTERVAL_MS;
      const delta =
        newest === null
          ? hubSize
          : (db.query("SELECT COUNT(*) AS n FROM crdt_changes WHERE hlc > ?").get(newest) as {
              n: number;
            }).n;
      const due =
        newest === null || // empty bucket → first snapshot now
        delta >= Math.max(minDelta, hubSize * ratio) ||
        (delta > 0 && Date.now() - hlcMs(newest) >= maxInterval); // trickle → safety cap
      // Only publish when we're the elected publisher among live candidates, so
      // multiple publishers don't all upload the same snapshot. Election is
      // best-effort (idempotent snapshots make a double-elect harmless).
      if (due && (await isElectedPublisher(client, base, node, opts.priority ?? 0))) {
        await publishSnapshot(db, client, config, opts.snapshotRetainSegments);
        didSnapshot = true;
      }
    }
  }

  // Keep the bucket bounded: snapshot + truncate once our own prefix grows large.
  // Only right after a push (when our segment count actually changed) and only if
  // the publisher path didn't already snapshot this round, so idle rounds don't
  // pay a LIST and we never snapshot twice.
  if (!didSnapshot && pushed > 0) {
    const threshold = opts.snapshotEverySegments ?? 200;
    const ownCount = (await client.list(nodePrefix(base, node))).filter((o) =>
      o.key.endsWith(".seg"),
    ).length;
    if (ownCount >= threshold) await publishSnapshot(db, client, config, opts.snapshotRetainSegments);
  }

  return { pushed, pulled };
}

/** Ingest only the snapshots we don't already cover, then prune the consumed set
 *  to keys still present so it stays bounded as old snapshots GC. ⑤b: a small
 *  frontier sidecar (.vc) lets a caught-up consumer skip the whole-hub body GET;
 *  newest-first so ingesting the latest dominates (and thus skips) older ones. */
async function pullSnapshots(
  db: DbDriver,
  peerUrl: string,
  present: string[],
  client: StorageClient,
  key: Uint8Array | null,
): Promise<number> {
  if (present.length === 0) return 0;
  const consumed = getSnapshotConsumed(db, peerUrl);
  const local = localFrontier(db);
  let pulled = 0;
  for (const k of [...present].sort().reverse()) {
    if (consumed.has(k)) continue;
    // Read the small frontier sidecar. If our local frontier already dominates
    // this snapshot we hold every winner in it → skip the whole-hub body GET.
    const metaBytes = await client.get(vcKey(k));
    const meta = metaBytes ? await decodeVc(metaBytes, key) : null;
    if (meta && dominates(local, meta.frontier)) {
      consumed.add(k);
      continue;
    }
    const bytes = await client.get(k);
    if (!bytes) continue;
    const changes = await decodeSegment(bytes, key);
    ingest(db, changes);
    pulled += changes.length;
    consumed.add(k);
    for (const c of changes)
      if (!local[c.node_id] || c.hlc > local[c.node_id]!) local[c.node_id] = c.hlc;
    // ⑤c: the snapshot already covers the publisher's retained segments up to
    // ownSegHigh — advance our cursor past them so the segment loop won't re-pull.
    if (meta?.ownSegHigh) {
      const cur = getStorageCursor(db, peerUrl, meta.ownNode);
      if (!cur || cur < meta.ownSegHigh)
        setStorageCursor(db, peerUrl, meta.ownNode, meta.ownSegHigh);
    }
  }
  // Forget keys no longer in the bucket (GC'd) so the set can't grow unbounded.
  const presentSet = new Set(present);
  setSnapshotConsumed(db, peerUrl, [...consumed].filter((k) => presentSet.has(k)));
  return pulled;
}
