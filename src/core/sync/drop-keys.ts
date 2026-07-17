// Write-inbox recipient keyring: the P-256 keypair(s) visitors seal envelopes
// to. Generated independently (WebCrypto cannot derive a P-256 keypair from a
// seed, so "derive from the master key" is technically impossible); the private
// key is wrapped with the bucket master key (e2ee encryptBytes) so the keyring
// object in the bucket stays as data-blind as everything else there.
//
// Authority model mirrors keys/main.json: when an encrypted bucket is attached,
// `<base>/keys/drop.json` is authoritative (If-None-Match first-create so two
// devices initializing concurrently can't clobber each other) and the local
// meta row is a cache; without a bucket the keyring lives only in local meta
// (private key stored raw there — same trust model as peers.config.masterKey).
//
// Rotation appends a new active key and marks the old ones retired; retired
// keys are KEPT so in-flight envelopes sealed before the rotation still open.
// `--purge-retired` drops keys that were already retired before this rotation
// (i.e. run it once the previous generation's envelopes have drained).

import type { DbDriver } from "../driver.ts";
import { MhError, errorCode } from "../errors.ts";
import { randomSuffix } from "../ids.ts";
import { listPeers } from "./peers.ts";
import {
  storageClientFor,
  storageBasePrefix,
  dropKeysObjectKey,
  type S3Config,
  type StorageClient,
} from "./storage.ts";
import { encryptBytes, decryptBytes, toB64, fromB64 } from "./e2ee.ts";
import { generateSealKeypair } from "./seal.ts";

export interface DropKeyRecord {
  key_id: string;
  /** base64 raw uncompressed P-256 public point — published in mh-drop.json. */
  pk: string;
  /** base64 private key: encryptBytes(masterKey, pkcs8) when `wrapped`, else raw pkcs8. */
  sk: string;
  wrapped: boolean;
  created_at: number;
  retired: boolean;
}

export interface DropKeyring {
  v: 1;
  keys: DropKeyRecord[];
}

const META_KEY = "drop_keys";

// ---- local cache -------------------------------------------------------------------

export function getLocalDropKeyring(db: DbDriver): DropKeyring | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(META_KEY) as
    | { value: string }
    | null;
  if (!row) return null;
  try {
    const kr = JSON.parse(row.value) as DropKeyring;
    return kr && kr.v === 1 && Array.isArray(kr.keys) ? kr : null;
  } catch {
    return null;
  }
}

export function saveLocalDropKeyring(db: DbDriver, kr: DropKeyring): void {
  db.query(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(META_KEY, JSON.stringify(kr));
}

// ---- bucket binding ----------------------------------------------------------------

/** The bucket a drop keyring anchors to: the first enabled ENCRYPTED s3 peer.
 *  A plaintext bucket is deliberately not used — a raw private key must never
 *  sit on third-party storage, so no-encrypted-bucket behaves like no bucket
 *  (keyring stays local-only). `client` is lazy so callers that only need the
 *  peer identity (push-cursor ack gate) never construct an S3 client. */
export interface DropBucket {
  peerUrl: string;
  config: S3Config;
  base: string;
  keyPath: string;
  masterKey: Uint8Array;
  client: () => StorageClient;
}

export function dropBucketFor(db: DbDriver): DropBucket | null {
  for (const p of listPeers(db)) {
    if (!p.enabled || p.kind !== "s3" || !p.config) continue;
    let config: S3Config;
    try {
      config = JSON.parse(p.config) as S3Config;
    } catch {
      continue;
    }
    if (!config.encrypt || !config.masterKey) continue;
    return {
      peerUrl: p.url,
      config,
      base: storageBasePrefix(config.prefix),
      keyPath: dropKeysObjectKey(config.prefix),
      masterKey: fromB64(config.masterKey),
      client: () => storageClientFor(config),
    };
  }
  return null;
}

// ---- key material ------------------------------------------------------------------

async function generateKeyRecord(masterKey: Uint8Array | null): Promise<DropKeyRecord> {
  const kp = await generateSealKeypair();
  return {
    key_id: "k" + randomSuffix(8),
    pk: toB64(kp.publicKey),
    sk: masterKey ? toB64(await encryptBytes(masterKey, kp.privateKey)) : toB64(kp.privateKey),
    wrapped: masterKey != null,
    created_at: Date.now(),
    retired: false,
  };
}

/** Wrap any raw-sk keys with the master key (local-only keyring meeting its
 *  first bucket). Already-wrapped keys pass through untouched. */
async function wrapKeyring(kr: DropKeyring, masterKey: Uint8Array): Promise<DropKeyring> {
  const keys: DropKeyRecord[] = [];
  for (const k of kr.keys) {
    keys.push(
      k.wrapped ? k : { ...k, sk: toB64(await encryptBytes(masterKey, fromB64(k.sk))), wrapped: true },
    );
  }
  return { v: 1, keys };
}

/** Parse + validate a keyring blob from the authoritative bucket. Rejects a
 *  malformed shape with invalid_input instead of blindly saving junk that a
 *  later getLocalDropKeyring would read back as null (silently emptying the
 *  keyring). Mirrors getLocalDropKeyring's shape check on every bucket read. */
function parseKeyring(bytes: Uint8Array, where: string): DropKeyring {
  let kr: unknown;
  try {
    kr = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new MhError("invalid_input", `${where} is not valid JSON`);
  }
  const k = kr as DropKeyring;
  if (!k || k.v !== 1 || !Array.isArray(k.keys)) throw new MhError("invalid_input", `${where} is malformed`);
  return k;
}

function encodeKeyring(kr: DropKeyring): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(kr));
}

/** Union two keyrings by key_id (primary wins on collision). Adopting the
 *  bucket's authoritative keyring must never DROP a key this device holds that
 *  the bucket lacks — e.g. one generated here before this bucket was attached,
 *  with in-flight mail sealed to its pk (dropping it strands that mail forever). */
function mergeKeyrings(primary: DropKeyring, extra: DropKeyring): DropKeyring {
  const byId = new Map<string, DropKeyRecord>();
  for (const k of primary.keys) byId.set(k.key_id, k);
  for (const k of extra.keys) if (!byId.has(k.key_id)) byId.set(k.key_id, k);
  return { v: 1, keys: [...byId.values()] };
}

/** Current ETag of the keyring object (targeted list), or null if absent / the
 *  client doesn't surface etags (then the caller forgoes CAS). */
async function keyringEtag(client: StorageClient, keyPath: string): Promise<string | null> {
  const objs = await client.list(keyPath);
  return objs.find((o) => o.key === keyPath)?.etag ?? null;
}

/** Compare-and-set write of the keyring, folding in (union by key_id) whatever a
 *  concurrent writer landed on a lost race — so two devices rotating at once can
 *  never clobber each other's freshly-appended key (each retries against the
 *  winner's version, and both keys survive). Unconditional put only on the very
 *  first create or a client without etags. */
async function putKeyringCas(client: StorageClient, keyPath: string, desired: DropKeyring): Promise<DropKeyring> {
  let merged = desired;
  for (let attempt = 0; attempt < 5; attempt++) {
    const etag = await keyringEtag(client, keyPath);
    try {
      await client.put(keyPath, encodeKeyring(merged), {
        contentType: "application/json",
        ...(etag ? { ifMatch: etag } : {}),
      });
      return merged;
    } catch (e) {
      if (errorCode(e) !== "conflict") throw e;
      const current = await client.get(keyPath);
      if (current) merged = mergeKeyrings(parseKeyring(current, "bucket keys/drop.json"), merged);
    }
  }
  throw new MhError("conflict", "drop keyring write kept losing to concurrent writers");
}

export function activeDropKey(kr: DropKeyring): DropKeyRecord {
  const live = kr.keys.filter((k) => !k.retired);
  const key = live[live.length - 1] ?? kr.keys[kr.keys.length - 1];
  if (!key) throw new MhError("not_found", "drop keyring is empty");
  return key;
}

export function findDropKey(kr: DropKeyring, keyId: string): DropKeyRecord | undefined {
  return kr.keys.find((k) => k.key_id === keyId);
}

/** Decrypt a key record's private half to raw PKCS#8 bytes. A wrapped key needs
 *  the bucket's master key; a mismatched master key fails the GCM tag → auth. */
export async function dropKeySecret(
  db: DbDriver,
  key: DropKeyRecord,
  opts: { bucket?: DropBucket | null } = {},
): Promise<Uint8Array> {
  if (!key.wrapped) return fromB64(key.sk);
  const bucket = opts.bucket !== undefined ? opts.bucket : dropBucketFor(db);
  if (!bucket)
    throw new MhError("auth", "drop key is wrapped with a bucket master key but no encrypted bucket is attached");
  return decryptBytes(bucket.masterKey, fromB64(key.sk)); // wrong key → MhError("auth")
}

// ---- provision / rotate -------------------------------------------------------------

/**
 * Load (or first-provision) the drop keyring. Bucket attached → the bucket
 * object is authoritative: adopt it when present; otherwise upload ours with
 * If-None-Match and adopt the winner on a lost first-create race (the exact
 * provisionMasterKey pattern). No bucket → local meta only.
 */
export async function ensureDropKeys(
  db: DbDriver,
  opts: { bucket?: DropBucket | null } = {},
): Promise<DropKeyring> {
  const bucket = opts.bucket !== undefined ? opts.bucket : dropBucketFor(db);
  if (!bucket) {
    let kr = getLocalDropKeyring(db);
    if (!kr) {
      kr = { v: 1, keys: [await generateKeyRecord(null)] };
      saveLocalDropKeyring(db, kr);
    }
    return kr;
  }

  const client = bucket.client();
  const remote = await client.get(bucket.keyPath);
  if (remote) {
    const remoteKr = parseKeyring(remote, "bucket keys/drop.json");
    const local = getLocalDropKeyring(db);
    // Union: adopt the bucket's authoritative keyring, but KEEP any key this
    // device holds that the bucket lacks (in-flight mail may be sealed to it) —
    // the old code blindly overwrote local, stranding that mail. Wrap the
    // local-only keys before they can be written back to third-party storage.
    const localOnly = local
      ? local.keys.filter((k) => !remoteKr.keys.some((r) => r.key_id === k.key_id))
      : [];
    if (localOnly.length === 0) {
      saveLocalDropKeyring(db, remoteKr);
      return remoteKr;
    }
    const wrapped = await wrapKeyring({ v: 1, keys: localOnly }, bucket.masterKey);
    const merged: DropKeyring = { v: 1, keys: [...remoteKr.keys, ...wrapped.keys] };
    // Best-effort: publish the union so other devices see our key too. If it
    // races/fails we still keep it locally and retry on the next ensureDropKeys.
    const written = await putKeyringCas(client, bucket.keyPath, merged).catch(() => merged);
    saveLocalDropKeyring(db, written);
    return written;
  }

  const local = getLocalDropKeyring(db);
  const kr: DropKeyring = local
    ? await wrapKeyring(local, bucket.masterKey)
    : { v: 1, keys: [await generateKeyRecord(bucket.masterKey)] };
  try {
    await client.put(bucket.keyPath, new TextEncoder().encode(JSON.stringify(kr)), {
      contentType: "application/json",
      ifNoneMatch: true,
    });
  } catch (e) {
    // Lost the first-create race: another device provisioned between our GET
    // and PUT — adopt the winner (its keys open with the shared master key).
    if (errorCode(e) === "conflict") {
      const winner = await client.get(bucket.keyPath);
      if (winner) {
        const wkr = parseKeyring(winner, "bucket keys/drop.json");
        saveLocalDropKeyring(db, wkr);
        return wkr;
      }
    }
    throw e;
  }
  saveLocalDropKeyring(db, kr);
  return kr;
}

/**
 * Rotate: append a fresh active key; every currently-active key becomes
 * retired (kept, so in-flight envelopes still open). With `purgeRetired`, keys
 * that were ALREADY retired before this call are dropped — the just-retired
 * generation always survives one rotation, so a rotate can never orphan mail
 * sealed a second earlier.
 */
export async function rotateDropKeys(
  db: DbDriver,
  opts: { purgeRetired?: boolean; bucket?: DropBucket | null } = {},
): Promise<{ keyring: DropKeyring; active: DropKeyRecord; purged: string[] }> {
  const bucket = opts.bucket !== undefined ? opts.bucket : dropBucketFor(db);
  const current = await ensureDropKeys(db, { bucket });
  const purged = opts.purgeRetired ? current.keys.filter((k) => k.retired).map((k) => k.key_id) : [];
  const kept = opts.purgeRetired ? current.keys.filter((k) => !k.retired) : current.keys;
  const fresh = await generateKeyRecord(bucket ? bucket.masterKey : null);
  const next: DropKeyring = {
    v: 1,
    keys: [...kept.map((k) => ({ ...k, retired: true })), fresh],
  };
  // Compare-and-set write-back so a concurrent rotation on another device can't
  // clobber our fresh key (or we theirs) — the loser folds in the winner's key
  // and retries, and both survive. `written` may carry the other device's fresh
  // key too; persist exactly what landed.
  const written = bucket ? await putKeyringCas(bucket.client(), bucket.keyPath, next) : next;
  saveLocalDropKeyring(db, written);
  return { keyring: written, active: fresh, purged };
}
