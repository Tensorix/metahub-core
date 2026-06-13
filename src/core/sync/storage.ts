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
//   <prefix>/spaces/default/snapshot/<hlc>.snap      winners-only baseline (any node publishes)
//   <prefix>/spaces/default/oplog/<node>/HEAD        latest segment key (cheap "anything new?" poll)
//   <prefix>/spaces/default/oplog/<node>/<seq>.seg   that node's ops, JSONL→gzip→AES-GCM
// The spaces/default/ level is reserved now so future per-space sharing needs
// no storage migration.

import type { DbDriver } from "../driver.ts";
import { getNodeId } from "../node.ts";
import { changesAfterSeq, ingest, CHANGE_SELECT, type Change } from "../crdt.ts";
import { MhError } from "../errors.ts";
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
}

export interface StorageObject {
  key: string;
  etag?: string;
}

/** The minimal object-store surface storage-sync needs. Implemented per runtime:
 *  Bun.S3Client on the CLI/desktop (storage-s3-bun.ts), WebCrypto SigV4 + fetch
 *  in the browser worker (webui/data/storage-s3-browser.ts). */
export interface StorageClient {
  /** Keys under `prefix`, ascending, optionally only those strictly after `startAfter`. */
  list(prefix: string, startAfter?: string): Promise<StorageObject[]>;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
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

/** Reserved cursor key for "which snapshot have we already ingested". Real node
 *  ids are 8-char random suffixes, so this sentinel can't collide with one. */
const SNAPSHOT_CURSOR = "__snapshot__";
const SEG_PAD = 16;

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

async function encodeSegment(changes: Change[], key: Uint8Array | null): Promise<Uint8Array> {
  const jsonl = changes.map((c) => JSON.stringify(c)).join("\n");
  const gz = await gzip(new TextEncoder().encode(jsonl));
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

// ---- node-prefix discovery ------------------------------------------------------

async function listRemoteNodes(client: StorageClient, base: string): Promise<string[]> {
  const objs = await client.list(oplogRoot(base));
  const root = oplogRoot(base);
  const nodes = new Set<string>();
  for (const o of objs) {
    const rest = o.key.slice(root.length); // "<node>/<file>"
    const slash = rest.indexOf("/");
    if (slash > 0) nodes.add(rest.slice(0, slash));
  }
  return [...nodes];
}

// ---- master-key provisioning (peer-add time) ------------------------------------

/**
 * Resolve the master key for a bucket at setup: read keys/main.json and unwrap
 * with the passphrase, or — when absent — generate a key, wrap it, and upload
 * it. Returns base64(K) to store in peers.config, or null when encryption is
 * off. Wrong passphrase throws `auth` (from unwrapMasterKey).
 */
export async function provisionMasterKey(
  client: StorageClient,
  config: S3Config,
  passphrase: string,
): Promise<string | null> {
  if (!config.encrypt) return null;
  const base = basePrefix(config.prefix);
  const existing = await client.get(mainKeyPath(base));
  if (existing) {
    const env = JSON.parse(new TextDecoder().decode(existing)) as KeyEnvelope;
    return toB64(await unwrapMasterKey(env, passphrase));
  }
  const K = generateMasterKey();
  const env = await wrapMasterKey(K, passphrase);
  await client.put(
    mainKeyPath(base),
    new TextEncoder().encode(JSON.stringify(env)),
    "application/json",
  );
  return toB64(K);
}

// ---- snapshot publish + truncation ----------------------------------------------

/**
 * Publish a winners-only snapshot and truncate this node's own segments. Every
 * op we've uploaded so far is in the local oplog now, so the snapshot (winners
 * as-of the current max HLC) supersedes all of them — they're safe to delete
 * (compact.ts invariant #1). Ops produced afterwards go into fresh, higher-keyed
 * segments; consumers reach our pre-snapshot state via the snapshot itself.
 * Returns the snapshot key + change count, or null when the oplog is empty.
 */
export async function publishSnapshot(
  db: DbDriver,
  client: StorageClient,
  config: S3Config,
): Promise<{ key: string; changes: number } | null> {
  const node = getNodeId(db);
  const key = masterKeyOf(config);
  const base = basePrefix(config.prefix);
  const winners = winnersSnapshot(db);
  if (winners.length === 0) return null;
  const maxHlc = winners.reduce((m, c) => (c.hlc > m ? c.hlc : m), "");
  const snapKey = `${snapshotRoot(base)}${maxHlc}.snap`;
  await client.put(snapKey, await encodeSegment(winners, key), "application/octet-stream");

  const ownSegs = (await client.list(nodePrefix(base, node))).filter((o) => o.key.endsWith(".seg"));
  for (const s of ownSegs) await client.del(s.key);
  return { key: snapKey, changes: winners.length };
}

// ---- one sync round -------------------------------------------------------------

export interface StorageSyncOpts {
  /** Publish a snapshot + truncate once this node's own segment count reaches
   *  this. Default 200 — high enough that typical use rarely hits it, low enough
   *  to keep the bucket bounded under heavy use. */
  snapshotEverySegments?: number;
}

/**
 * One push/pull round against a storage peer. Push uploads this node's pending
 * own ops as a new segment; pull hydrates from the latest snapshot (if newer
 * than what we've ingested) then drains each other node's new segments. Returns
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
  if (batch.changes.length > 0) {
    const k = segKey(base, node, batch.cursor);
    await client.put(k, await encodeSegment(batch.changes, key), "application/octet-stream");
    await client.put(headKey(base, node), new TextEncoder().encode(k), "text/plain");
    pushed = batch.changes.length;
  }
  setPushCursor(db, peerUrl, batch.cursor);

  // PULL: snapshot first (cheap idempotent re-skip via the snapshot cursor)…
  let pulled = 0;
  pulled += await pullSnapshot(db, peerUrl, client, base, key);

  // …then each other node's new segments.
  for (const remote of await listRemoteNodes(client, base)) {
    if (remote === node) continue; // never pull our own prefix back in
    const cursor = getStorageCursor(db, peerUrl, remote);
    // Cheap skip: HEAD names the latest segment key; if we're already at/after
    // it, there's nothing new — avoids a LIST when the peer is idle.
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

  // Keep the bucket bounded: snapshot + truncate once our prefix grows large.
  const threshold = opts.snapshotEverySegments ?? 200;
  const ownCount = (await client.list(nodePrefix(base, node))).filter((o) =>
    o.key.endsWith(".seg"),
  ).length;
  if (ownCount >= threshold) await publishSnapshot(db, client, config);

  return { pushed, pulled };
}

/** Ingest the latest snapshot if it's newer than the one we last ingested. */
async function pullSnapshot(
  db: DbDriver,
  peerUrl: string,
  client: StorageClient,
  base: string,
  key: Uint8Array | null,
): Promise<number> {
  const snaps = (await client.list(snapshotRoot(base)))
    .map((o) => o.key)
    .filter((k) => k.endsWith(".snap"))
    .sort();
  const latest = snaps.at(-1);
  if (!latest) return 0;
  const consumed = getStorageCursor(db, peerUrl, SNAPSHOT_CURSOR);
  if (consumed && consumed >= latest) return 0;
  const bytes = await client.get(latest);
  if (!bytes) return 0;
  const changes = await decodeSegment(bytes, key);
  ingest(db, changes);
  setStorageCursor(db, peerUrl, SNAPSHOT_CURSOR, latest);
  return changes.length;
}
