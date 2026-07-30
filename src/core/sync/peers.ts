// Outbound peer management: the devices this node syncs *to*. Each row carries
// the durable credential the remote issued to us during pairing (see pairing.ts)
// plus replication cursors and last-sync status. `syncAllPeers` is what the
// server's auto-sync timer calls each tick.

import type { DbDriver } from "../driver.ts";
import { MhError, errorCode } from "../errors.ts";
import { syncWithPeer, type SyncResult } from "./client.ts";
import { storageUrl } from "./storage-url.ts";
import {
  syncWithStorage,
  storageClientFor,
  provisionMasterKey,
  verifyMasterKey,
  rewrapMasterKey,
  readMasterKeyEnvelope,
  storageBasePrefix,
  type S3Config,
  type StorageSyncOpts,
} from "./storage.ts";
import { decodeRecoveryCode } from "./recovery.ts";
import { encodeEnroll } from "./enroll.ts";
import { toB64, fromB64, unwrapMasterKey } from "./e2ee.ts";
import { clearCoveredSiteRollbacks } from "./site-publish-recovery.ts";
import { HEALTH_PATH, HealthResponseSchema, type HealthResponse } from "./protocol.ts";
import pkg from "../../../package.json" with { type: "json" };

const PEER_COLS =
  "url, pull_cursor, push_cursor, token, label, node_id, enabled, last_sync_at, last_success_at, last_status, last_error, kind, config";
const syncInFlight = new WeakMap<object, Map<string, Promise<PeerSyncOutcome>>>();

async function waitForPeerIdle(db: DbDriver, url: string): Promise<void> {
  const existing = syncInFlight.get(db as object)?.get(url);
  if (existing) await existing.catch(() => undefined);
}

export interface PeerRow {
  url: string;
  pull_cursor: number;
  push_cursor: number;
  token: string | null;
  label: string | null;
  node_id: string | null;
  enabled: number;
  /** Last sync attempt, successful or failed. */
  last_sync_at: number | null;
  /** Last successful sync. Freshness gates must use this, not last_sync_at. */
  last_success_at: number | null;
  last_status: string | null;
  last_error: string | null;
  /** Transport: 'http' (POST /sync) or 's3' (bucket store-and-forward). */
  kind: string;
  /** JSON S3Config for 's3' peers; null for 'http'. */
  config: string | null;
}

export function listPeers(db: DbDriver): PeerRow[] {
  return db.query(`SELECT ${PEER_COLS} FROM peers ORDER BY url`).all() as PeerRow[];
}

export function getPeer(db: DbDriver, url: string): PeerRow | null {
  return (
    (db.query(`SELECT ${PEER_COLS} FROM peers WHERE url = ?`).get(url) as PeerRow | null) ?? null
  );
}

export interface AddPeerInput {
  url: string;
  token?: string | null;
  label?: string | null;
  node_id?: string | null;
}

/** Upsert a peer, preserving replication cursors on conflict. */
export function addPeer(db: DbDriver, input: AddPeerInput): void {
  db.query(
    `INSERT INTO peers (url, token, label, node_id, enabled, pull_cursor, push_cursor)
     VALUES (?, ?, ?, ?, 1, 0, 0)
     ON CONFLICT(url) DO UPDATE SET
       token   = coalesce(excluded.token, peers.token),
       label   = coalesce(excluded.label, peers.label),
       node_id = coalesce(excluded.node_id, peers.node_id),
       enabled = 1`,
  ).run(input.url, input.token ?? null, input.label ?? null, input.node_id ?? null);
}

export interface AddStoragePeerInput {
  /** Synthetic peer key, by convention s3://<bucket>/<prefix>. */
  url: string;
  config: S3Config;
  label?: string | null;
}

/** Upsert an 's3' (bucket store-and-forward) peer, preserving cursors on conflict. */
export function addStoragePeer(db: DbDriver, input: AddStoragePeerInput): void {
  db.query(
    `INSERT INTO peers (url, kind, config, label, enabled, pull_cursor, push_cursor)
     VALUES (?, 's3', ?, ?, 1, 0, 0)
     ON CONFLICT(url) DO UPDATE SET
       kind    = 's3',
       config  = excluded.config,
       label   = coalesce(excluded.label, peers.label),
       enabled = 1`,
  ).run(input.url, JSON.stringify(input.config), input.label ?? null);
}

/** Connection settings of a kind='room' peer (a Durable Object room serving
 *  one share). Node-local like every peers.config. `base` is the worker origin,
 *  `slug` the share/room id, `ownerSecret` the Bearer credential for the
 *  owner-side sync endpoint — independent of the master token by design. */
export interface RoomPeerConfig {
  base: string;
  slug: string;
  ownerSecret: string;
  /** The share's base guest node id (pull filter + sub-id derivation). Persisted
   *  here because a read-only share row carries no guest_node_id of its own. */
  guestBase?: string;
  lifecycle?: "provisioning" | "active" | "cleanup_pending";
  cleanupError?: string;
}

export interface AddRoomPeerInput {
  /** Synthetic peer key, by convention room://<slug>. */
  url: string;
  config: RoomPeerConfig;
  label?: string | null;
}

/** Upsert a 'room' peer, preserving replication cursors on conflict. */
export function addRoomPeer(db: DbDriver, input: AddRoomPeerInput): void {
  db.query(
    `INSERT INTO peers (url, kind, config, label, enabled, pull_cursor, push_cursor)
     VALUES (?, 'room', ?, ?, 1, 0, 0)
     ON CONFLICT(url) DO UPDATE SET
       kind    = 'room',
       config  = excluded.config,
       label   = coalesce(excluded.label, peers.label),
       enabled = 1`,
  ).run(input.url, JSON.stringify(input.config), input.label ?? null);
}

function restorePeerRow(db: DbDriver, row: PeerRow): void {
  db.query(
    `UPDATE peers SET
       pull_cursor = ?,
       push_cursor = ?,
       token = ?,
       label = ?,
       node_id = ?,
       enabled = ?,
       last_sync_at = ?,
       last_success_at = ?,
       last_status = ?,
       last_error = ?,
       kind = ?,
       config = ?
     WHERE url = ?`,
  ).run(
    row.pull_cursor,
    row.push_cursor,
    row.token,
    row.label,
    row.node_id,
    row.enabled,
    row.last_sync_at,
    row.last_success_at,
    row.last_status,
    row.last_error,
    row.kind,
    row.config,
    row.url,
  );
}

// The storage-peer key derivation lives in the runtime-agnostic storage-url.ts
// so the worker and the schema migration share one definition; re-exported here
// for existing `from "./peers.ts"` importers.
export { storageUrl, storageEndpointHost } from "./storage-url.ts";

export interface StoragePeerSpec {
  endpoint: string;
  region?: string;
  bucket: string;
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Virtual-hosted (COS) vs path-style addressing; undefined → auto-detect.
   *  Carried by enroll codes so COS buckets join correctly. */
  virtualHostedStyle?: boolean;
  /** Default true; pass false for `--no-encrypt` plaintext buckets. */
  encrypt?: boolean;
  /** Required when encrypt — provisions/adopts the bucket's wrapped master key. */
  passphrase?: string;
  /** Alternative to the passphrase: an MH1- recovery code carrying the master
   *  key directly ("忘记口令" join). Verified against the bucket's ciphertext and
   *  used as-is — this path NEVER writes keys/main.json. */
  recoveryCode?: string;
  /** Mark this node the bucket's publisher (writes whole-hub snapshots). */
  publish?: boolean;
  priority?: number;
  label?: string | null;
}

/**
 * Resolve + persist an S3 storage peer and run one sync so a bad endpoint /
 * credentials / missing CORS fail fast at the call site. Shared by the CLI
 * (`mh config peer add --s3`) and the WebUI server endpoint (`POST /api/peer/s3`)
 * so both go through the exact same provisioning + first-sync path. Returns the
 * resolved config (incl. the wrapped master key) and the first sync outcome.
 */
export async function addAndSyncStoragePeer(
  db: DbDriver,
  spec: StoragePeerSpec,
): Promise<{ url: string; config: S3Config; sync: PeerSyncOutcome }> {
  const prefix = spec.prefix?.trim() || "metahub";
  const encrypt = spec.encrypt !== false;
  const config: S3Config = {
    endpoint: spec.endpoint.trim(),
    region: spec.region?.trim() || "auto",
    bucket: spec.bucket.trim(),
    prefix,
    accessKeyId: spec.accessKeyId.trim(),
    secretAccessKey: spec.secretAccessKey.trim(),
    encrypt,
    virtualHostedStyle: spec.virtualHostedStyle,
    publish: spec.publish,
    priority: spec.priority,
  };
  if (encrypt) {
    if (spec.recoveryCode) {
      // Join via recovery code: the code IS the master key. Verify it against
      // the bucket's ciphertext (a valid code for the WRONG bucket must not get
      // in), then adopt it without touching keys/main.json.
      const rawKey = await decodeRecoveryCode(spec.recoveryCode);
      await verifyMasterKey(storageClientFor(config), config, rawKey);
      config.masterKey = toB64(rawKey);
    } else if (spec.passphrase) {
      config.masterKey =
        (await provisionMasterKey(storageClientFor(config), config, spec.passphrase)) ?? undefined;
    } else {
      throw new MhError(
        "invalid_input",
        "encrypted bucket needs a passphrase (or a recovery code if the passphrase is lost)",
      );
    }
  }
  const url = storageUrl(config.endpoint, config.bucket, prefix);
  await waitForPeerIdle(db, url);
  const previous = getPeer(db, url);
  addStoragePeer(db, { url, config, label: spec.label ?? config.bucket });
  const sync = await syncPeer(db, url);
  if (!sync.ok) {
    if (previous) restorePeerRow(db, previous);
    else removePeer(db, url);
    throw new MhError("network", `storage peer first sync failed: ${sync.error ?? "unknown error"}`);
  }
  return { url, config, sync };
}

/** Replace an s3 peer's config JSON in place. Cursors, status and label are
 *  untouched — a credential/passphrase rotation moves no bucket objects, so
 *  replication state stays valid. */
export function updateStoragePeerConfig(db: DbDriver, url: string, config: S3Config): void {
  const changed =
    db
      .query("UPDATE peers SET config = ? WHERE url = ? AND kind = 's3'")
      .run(JSON.stringify(config), url).changes > 0;
  if (!changed) throw new MhError("not_found", `no S3 storage peer at '${url}'`);
}

export interface RotateStoragePeerInput {
  /** New S3 credentials (both or neither) — minted by the user at the provider;
   *  the old keys stay valid until the user disables them AFTER the rotate. */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Rewrap keys/main.json under this passphrase (K itself never changes). */
  newPassphrase?: string;
  /** Optional K sources when this device's config lost its cached master key:
   *  the printed recovery code, or the current passphrase (unwraps the bucket
   *  envelope). The cached key, when present, needs neither. */
  oldPassphrase?: string;
  recoveryCode?: string;
}

export interface RotateOutcome {
  url: string;
  rotatedCredentials: boolean;
  rotatedPassphrase: boolean;
  /** Whether K was cryptographically checked against bucket ciphertext:
   *  "skipped" = K came from this device's own trusted config. */
  keyVerified: "verified" | "no_ciphertext" | "skipped";
  /** Post-rotate sync (effect evidence the new credentials work end-to-end).
   *  Not rolled back on failure — the new creds are the intended end state. */
  sync: PeerSyncOutcome;
  /** Fresh enroll token (new credentials) for re-attaching other devices. */
  enroll: string;
}

/**
 * Rotate an S3 storage peer's credentials and/or passphrase — the "lost
 * device" remedy. Ordered so every failure point either mutates nothing or is
 * safely re-runnable (idempotent: same K, CAS'd envelope, upsert config):
 * validate new creds (zero side effects) → resolve K (cached / recovery code /
 * old passphrase) → verify K against ciphertext when it came from outside →
 * CAS-rewrap the envelope → persist local config → one sync as effect
 * evidence. A crash between rewrap and persist is healed by re-running the
 * same command.
 */
export async function rotateStoragePeer(
  db: DbDriver,
  url: string,
  input: RotateStoragePeerInput,
): Promise<RotateOutcome> {
  // PREFLIGHT — nothing mutated on any throw below until the REWRAP step.
  const peer = getPeer(db, url);
  if (!peer || peer.kind !== "s3" || !peer.config)
    throw new MhError("not_found", `no S3 storage peer at '${url}'`);
  const current = JSON.parse(peer.config) as S3Config;
  const wantCreds = input.accessKeyId != null || input.secretAccessKey != null;
  if (wantCreds && (!input.accessKeyId?.trim() || !input.secretAccessKey?.trim()))
    throw new MhError("invalid_input", "new credentials need both the access key id and secret");
  if (input.newPassphrase && !current.encrypt)
    throw new MhError("invalid_input", "bucket is not encrypted — no passphrase to change");
  if (!wantCreds && !input.newPassphrase)
    throw new MhError("invalid_input", "nothing to rotate: pass new credentials and/or a new passphrase");
  await waitForPeerIdle(db, url);

  // VALIDATE_CREDS — probe with the candidate credentials before touching anything.
  const candidate: S3Config = {
    ...current,
    ...(wantCreds
      ? { accessKeyId: input.accessKeyId!.trim(), secretAccessKey: input.secretAccessKey!.trim() }
      : {}),
  };
  const client = storageClientFor(candidate);
  try {
    await client.list(`${storageBasePrefix(candidate.prefix)}/keys/`);
  } catch (e) {
    throw new MhError(
      errorCode(e) === "auth" ? "auth" : "network",
      `the new credentials failed against the bucket (nothing changed; the old keys still work): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // RESOLVE_KEY + VERIFY_KEY — only needed for a passphrase change.
  let rawKey: Uint8Array | null = null;
  let keyVerified: RotateOutcome["keyVerified"] = "skipped";
  if (input.newPassphrase) {
    if (current.masterKey) {
      rawKey = fromB64(current.masterKey); // normal path: no old passphrase needed
    } else if (input.recoveryCode) {
      rawKey = await decodeRecoveryCode(input.recoveryCode);
      keyVerified = await verifyMasterKey(client, candidate, rawKey); // throws auth on mismatch
    } else if (input.oldPassphrase) {
      const env = await readMasterKeyEnvelope(client, candidate);
      if (!env)
        throw new MhError(
          "invalid_input",
          "bucket has no key envelope to unwrap — use the recovery code instead",
        );
      rawKey = await unwrapMasterKey(env, input.oldPassphrase); // throws auth on wrong passphrase
      keyVerified = await verifyMasterKey(client, candidate, rawKey);
    } else {
      throw new MhError(
        "invalid_input",
        "this device has no cached master key — provide the recovery code or the current passphrase",
      );
    }

    // REWRAP — CAS on the envelope's ETag; one automatic retry on a concurrent
    // rewrap (idempotent: same K), then surface the conflict.
    try {
      await rewrapMasterKey(client, candidate, rawKey, input.newPassphrase);
    } catch (e) {
      if (errorCode(e) !== "conflict") throw e;
      await rewrapMasterKey(client, candidate, rawKey, input.newPassphrase);
    }
  }

  // PERSIST_LOCAL — cursors untouched (no bucket object moved). Also heals a
  // config whose cached key was missing, now that we resolved it.
  const next: S3Config = {
    ...candidate,
    masterKey: current.masterKey ?? (rawKey ? toB64(rawKey) : undefined),
  };
  updateStoragePeerConfig(db, url, next);

  // VERIFY_SYNC — effect evidence; a failure here is NOT rolled back (the new
  // credentials are the intended end state; the caller retries the sync).
  const sync = await syncPeer(db, url);

  return {
    url,
    rotatedCredentials: wantCreds,
    rotatedPassphrase: !!input.newPassphrase,
    keyVerified,
    sync,
    enroll: encodeEnroll({
      endpoint: next.endpoint,
      region: next.region,
      bucket: next.bucket,
      prefix: next.prefix,
      accessKeyId: next.accessKeyId,
      secretAccessKey: next.secretAccessKey,
      encrypt: next.encrypt,
      virtualHostedStyle: next.virtualHostedStyle,
    }),
  };
}

/**
 * Remove a peer AND revoke the credential we issued to it during pairing, so
 * disconnecting is mutual: we stop syncing out to it (peers row) and it can no
 * longer sync in to us (peer_grants row, keyed by peer_url). Grants minted for a
 * peer that never sent a self_url have a null peer_url and can't be revoked here.
 */
export function removePeer(db: DbDriver, url: string): boolean {
  const tx = db.transaction(() => {
    const changed = db.query("DELETE FROM peers WHERE url = ?").run(url).changes > 0;
    db.query("DELETE FROM peer_grants WHERE peer_url = ?").run(url);
    // Drop any storage-sync per-node cursors for this peer (no-op for http peers).
    db.query("DELETE FROM storage_cursors WHERE peer_url = ?").run(url);
    // Drop the room-partition shadow for this peer (no-op for non-room peers).
    db.query("DELETE FROM room_rows WHERE peer_key = ?").run(url);
    return changed;
  });
  return tx();
}

export function setPeerEnabled(db: DbDriver, url: string, enabled: boolean): boolean {
  return (
    db.query("UPDATE peers SET enabled = ? WHERE url = ?").run(enabled ? 1 : 0, url).changes > 0
  );
}

export function setPeerLabel(db: DbDriver, url: string, label: string): boolean {
  return db.query("UPDATE peers SET label = ? WHERE url = ?").run(label, url).changes > 0;
}

export function updatePeerStatus(
  db: DbDriver,
  url: string,
  status: string,
  error?: string | null,
): void {
  const now = Date.now();
  if (status === "ok") {
    db.query(
      "UPDATE peers SET last_sync_at = ?, last_success_at = ?, last_status = ?, last_error = ? WHERE url = ?",
    ).run(now, now, status, error ?? null, url);
    return;
  }
  db.query(
    "UPDATE peers SET last_sync_at = ?, last_status = ?, last_error = ? WHERE url = ?",
  ).run(now, status, error ?? null, url);
}

export interface PeerSyncOutcome {
  url: string;
  ok: boolean;
  pushed?: number;
  pulled?: number;
  pendingPush?: boolean;
  error?: string;
  /** Non-fatal follow-up problems (e.g. channel maintenance) after a
   * SUCCESSFUL data sync. Never flips `ok` and never sets a network error. */
  warnings?: string[];
}

/** Sync once with a single peer, recording status. Errors are captured, not
 *  thrown. Dispatches on transport: 's3' peers go through the bucket
 *  store-and-forward client, everything else POSTs /sync. */
export async function syncPeer(
  db: DbDriver,
  url: string,
  opts?: { storage?: StorageSyncOpts; timeoutMs?: number },
): Promise<PeerSyncOutcome> {
  let byUrl = syncInFlight.get(db as object);
  if (!byUrl) {
    byUrl = new Map();
    syncInFlight.set(db as object, byUrl);
  }
  const existing = byUrl.get(url);
  if (existing) return existing;
  const run = syncPeerOnce(db, url, opts).finally(() => {
    if (byUrl.get(url) === run) byUrl.delete(url);
  });
  byUrl.set(url, run);
  return run;
}

/** Mixed-version workspace warning, from a peer's /health handshake. A peer
 *  without the site_channels capability treats v2 channel rows as malformed
 *  (validRow fail-closed), so publish/share changes silently do nothing there
 *  — that deserves a loud line, not a shrug. Pure for tests. */
export function versionWarning(local: string, health: HealthResponse | null): string | null {
  if (!health) return null; // old peer without /health data — nothing to claim
  if (health.capabilities && !health.capabilities.includes("site_channels"))
    return `对端未升级（不支持站点渠道）：站点发布/分享的变更在它升级前不会生效`;
  if (health.version && health.version !== local)
    return `对端运行 core ${health.version}，本机为 ${local}；混合版本工作区的新功能可能不生效`;
  return null;
}

/** Best-effort /health probe after a successful HTTP sync (5s cap, never
 *  throws). Old servers without the fields → null → no warning (don't guess). */
async function probePeerHealth(url: string): Promise<HealthResponse | null> {
  try {
    const res = await fetch(new URL(HEALTH_PATH, url), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const parsed = HealthResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function syncPeerOnce(
  db: DbDriver,
  url: string,
  opts?: { storage?: StorageSyncOpts; timeoutMs?: number },
): Promise<PeerSyncOutcome> {
  try {
    const peer = getPeer(db, url);
    let result: SyncResult;
    if (peer?.kind === "s3") {
      if (!peer.config) throw new Error(`storage peer ${url} has no config`);
      const config = JSON.parse(peer.config) as S3Config;
      // The persisted per-node role (publish/priority) drives snapshot publishing;
      // the caller's opts (forcePush, batching) layer on top.
      const storageOpts: StorageSyncOpts = {
        ...opts?.storage,
        publish: opts?.storage?.publish ?? config.publish,
        priority: opts?.storage?.priority ?? config.priority,
      };
      result = await syncWithStorage(db, url, storageClientFor(config), config, storageOpts);
    } else if (peer?.kind === "room") {
      // Room peers sync through room-client's syncWithRoom over the HTTP
      // transport in room-peer.ts (lazy import: rooms stay off the startup
      // path until one actually exists).
      const { syncRoomPeer } = await import("./room-peer.ts");
      result = await syncRoomPeer(db, peer);
    } else {
      result = await syncWithPeer(db, url, { timeoutMs: opts?.timeoutMs });
    }
    updatePeerStatus(db, url, "ok", null);
    // The data sync SUCCEEDED past this point: local follow-up work (rollback
    // bookkeeping, channel reconcile) must never rewrite the peer status to
    // "error" or flip the outcome — it degrades to warnings instead.
    const warnings: string[] = [];
    try {
      if (peer?.kind !== "s3" && peer?.kind !== "room") clearCoveredSiteRollbacks(db, url);
    } catch (e) {
      warnings.push(`site rollback bookkeeping failed: ${(e as Error).message}`);
    }
    if (peer?.kind !== "s3" && peer?.kind !== "room") {
      const mixed = versionWarning(pkg.version, await probePeerHealth(url));
      if (mixed) warnings.push(`${url}: ${mixed}`);
    }
    const { reconcileSiteChannelsQuietly } = await import("./site-channel-reconcile.ts");
    const reconcileError = await reconcileSiteChannelsQuietly(db);
    if (reconcileError) warnings.push(`site channel reconcile failed: ${reconcileError}`);
    return {
      url,
      ok: true,
      pushed: result.pushed,
      pulled: result.pulled,
      pendingPush: result.pendingPush,
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (e) {
    const error = (e as Error).message;
    updatePeerStatus(db, url, "error", error);
    return { url, ok: false, error };
  }
}

/** Sync once with every enabled peer. Used by the auto-sync timer. */
export async function syncAllPeers(db: DbDriver): Promise<PeerSyncOutcome[]> {
  const peers = listPeers(db).filter((p) => p.enabled);
  const out: PeerSyncOutcome[] = [];
  for (const p of peers) out.push(await syncPeer(db, p.url));
  return out;
}

/** Reads within this of the last successful sync skip the network entirely. */
const DEFAULT_FRESH_MAX_AGE_MS = 3 * 60_000;
/** Bound on the blocking pre-read sync so a read never hangs on a slow bucket. */
const FRESH_SYNC_TIMEOUT_MS = 8_000;

/**
 * Freshness gate for *non-reactive* consumers — CLI reads and the PWA's served
 * site pages (②b). Their local DB is only as fresh as the last sync, and unlike
 * the reactive WebUI they have no background poll and no `synced` revalidate. So
 * if the newest successful peer sync is older than `maxAgeMs`, block on one
 * bounded sync round before the caller reads; otherwise return immediately
 * (read local).
 *
 * No enabled peers → no-op. A running daemon keeps `last_success_at` recent, so
 * this is a near-instant no-op there and only does real work on a daemon-less node
 * that hasn't synced successfully in a while. Failed attempts update
 * `last_sync_at`, but never make local data fresh. Env overrides: MH_OFFLINE=1
 * skips; MH_FRESH=1 forces; MH_SYNC_MAX_AGE=<ms> tunes the threshold.
 */
export async function ensureFresh(
  db: DbDriver,
  opts: { maxAgeMs?: number; force?: boolean; offline?: boolean } = {},
): Promise<void> {
  if (opts.offline ?? process.env.MH_OFFLINE === "1") return;
  const peers = listPeers(db).filter((p) => p.enabled);
  if (peers.length === 0) return;
  if (!(opts.force ?? process.env.MH_FRESH === "1")) {
    const maxAge = opts.maxAgeMs ?? (Number(process.env.MH_SYNC_MAX_AGE) || DEFAULT_FRESH_MAX_AGE_MS);
    const last = Math.max(0, ...peers.map((p) => p.last_success_at ?? 0));
    if (last && Date.now() - last < maxAge) return; // fresh enough → read local
  }
  // Stale (or forced): one bounded sync; on timeout/error fall back to local data.
  await Promise.race([
    syncAllPeers(db).then(() => undefined),
    new Promise<undefined>((r) => setTimeout(r, FRESH_SYNC_TIMEOUT_MS)),
  ]).catch(() => undefined);
}
