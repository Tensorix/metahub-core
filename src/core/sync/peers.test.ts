import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { createDatabase } from "../databases.ts";
import { MhError } from "../errors.ts";
import {
  addAndSyncStoragePeer,
  addPeer,
  addStoragePeer,
  ensureFresh,
  getPeer,
  rotateStoragePeer,
  syncPeer,
  updatePeerStatus,
} from "./peers.ts";
import {
  setStorageClientFactory,
  syncWithStorage,
  readMasterKeyEnvelope,
  type S3Config,
  type StorageClient,
  type StorageObject,
  type StoragePutOpts,
} from "./storage.ts";
import { generateMasterKey, toB64, unwrapMasterKey, wrapMasterKey } from "./e2ee.ts";
import { encodeRecoveryCode } from "./recovery.ts";
import { decodeEnroll } from "./enroll.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  runSchema(db);
  return db;
}

class TestBucket implements StorageClient {
  store = new Map<string, Uint8Array>();
  versions = new Map<string, number>();
  puts = 0;
  delayPut = false;
  failList = false;
  /** Simulate a concurrent CAS winner: fail the next ifMatch put once. */
  failIfMatchOnce = false;

  etagOf(key: string): string | undefined {
    const v = this.versions.get(key);
    return v ? `"v${v}"` : undefined;
  }
  async list(prefix: string, startAfter?: string, delimiter?: string): Promise<StorageObject[]> {
    if (this.failList) throw new Error("bucket unavailable");
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix) && (startAfter == null || k > startAfter))
      .sort();
    if (!delimiter) return keys.map((key) => ({ key, etag: this.etagOf(key) }));
    const out: StorageObject[] = [];
    const prefixes = new Set<string>();
    for (const k of keys) {
      const rest = k.slice(prefix.length);
      const i = rest.indexOf(delimiter);
      if (i >= 0) prefixes.add(prefix + rest.slice(0, i + 1));
      else out.push({ key: k, etag: this.etagOf(k) });
    }
    for (const p of prefixes) out.push({ key: p });
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, body: Uint8Array, opts?: StoragePutOpts): Promise<void> {
    this.puts++;
    if (this.delayPut) await new Promise((resolve) => setTimeout(resolve, 20));
    if (opts?.ifNoneMatch && this.store.has(key))
      throw new MhError("conflict", `S3 object already exists: ${key}`);
    if (opts?.ifMatch) {
      if (this.failIfMatchOnce) {
        this.failIfMatchOnce = false;
        throw new MhError("conflict", "concurrent writer won the CAS");
      }
      if (this.etagOf(key) !== opts.ifMatch)
        throw new MhError("conflict", `etag mismatch on ${key}`);
    }
    this.store.set(key, body);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
    this.versions.delete(key);
  }
}

function s3Config(endpoint = "https://old.example"): S3Config {
  return {
    endpoint,
    region: "auto",
    bucket: "bucket",
    prefix: "metahub",
    accessKeyId: "id",
    secretAccessKey: "secret",
    encrypt: false,
  };
}

test("updatePeerStatus records attempts but only successful syncs update freshness", () => {
  const db = makeDb();
  addPeer(db, { url: "http://peer" });

  updatePeerStatus(db, "http://peer", "error", "offline");
  let row = db.query("SELECT last_sync_at, last_success_at, last_status FROM peers WHERE url = ?").get(
    "http://peer",
  ) as { last_sync_at: number | null; last_success_at: number | null; last_status: string };
  expect(typeof row.last_sync_at).toBe("number");
  expect(row.last_success_at).toBeNull();
  expect(row.last_status).toBe("error");

  updatePeerStatus(db, "http://peer", "ok", null);
  row = db.query("SELECT last_sync_at, last_success_at, last_status FROM peers WHERE url = ?").get(
    "http://peer",
  ) as { last_sync_at: number | null; last_success_at: number | null; last_status: string };
  expect(typeof row.last_sync_at).toBe("number");
  expect(typeof row.last_success_at).toBe("number");
  expect(row.last_status).toBe("ok");
});

test("ensureFresh ignores a recent failed attempt when there is no recent success", async () => {
  const db = makeDb();
  addPeer(db, { url: "http://127.0.0.1:9" });
  updatePeerStatus(db, "http://127.0.0.1:9", "error", "offline");

  await ensureFresh(db, { maxAgeMs: 60_000 });

  const row = db.query("SELECT last_status, last_success_at FROM peers WHERE url = ?").get(
    "http://127.0.0.1:9",
  ) as { last_status: string | null; last_success_at: number | null };
  expect(row.last_status).toBe("error");
  expect(row.last_success_at).toBeNull();
});

test("syncPeer coalesces concurrent rounds for the same peer", async () => {
  const db = makeDb();
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run("nodeAAAA");
  const bucket = new TestBucket();
  bucket.delayPut = true;
  setStorageClientFactory(() => bucket);
  const url = "s3://bucket/metahub";
  addStoragePeer(db, { url, config: s3Config(), label: "bucket" });
  createDatabase(db, { name: "Tasks" });

  const [a, b] = await Promise.all([syncPeer(db, url), syncPeer(db, url)]);

  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
  expect(bucket.puts).toBe(2); // HEAD + one segment, not doubled by the second caller
});

test("reconcile failure after a successful data sync degrades to warnings, not an error", async () => {
  const db = makeDb();
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run("nodeAAAA");
  const bucket = new TestBucket();
  setStorageClientFactory(() => bucket);
  const url = "s3://bucket/metahub";
  addStoragePeer(db, { url, config: s3Config(), label: "bucket" });
  createDatabase(db, { name: "Tasks" });
  // Force channel maintenance to blow up while the data sync itself succeeds.
  db.exec("DROP TABLE site_channels");

  const outcome = await syncPeer(db, url);
  expect(outcome.ok).toBe(true);
  expect(outcome.error).toBeUndefined();
  expect(outcome.warnings?.length).toBeGreaterThan(0);
  expect(outcome.warnings![0]).toContain("reconcile failed");
  // The peer status stays "ok": the data really is synced.
  const row = db
    .query("SELECT last_status, last_success_at FROM peers WHERE url = ?")
    .get(url) as { last_status: string; last_success_at: number | null };
  expect(row.last_status).toBe("ok");
  expect(typeof row.last_success_at).toBe("number");
});

test("a failed data sync reports the error without warnings noise", async () => {
  const db = makeDb();
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run("nodeAAAA");
  const bucket = new TestBucket();
  bucket.failList = true;
  setStorageClientFactory(() => bucket);
  const url = "s3://bucket/metahub";
  addStoragePeer(db, { url, config: s3Config(), label: "bucket" });

  const outcome = await syncPeer(db, url);
  expect(outcome.ok).toBe(false);
  expect(outcome.error).toBeTruthy();
  expect(outcome.warnings).toBeUndefined();
});

test("addAndSyncStoragePeer fails fast and removes a new peer when first sync fails", async () => {
  const db = makeDb();
  const bucket = new TestBucket();
  bucket.failList = true;
  setStorageClientFactory(() => bucket);

  await expect(
    addAndSyncStoragePeer(db, {
      endpoint: "https://bad.example",
      bucket: "bucket",
      accessKeyId: "id",
      secretAccessKey: "secret",
      encrypt: false,
    }),
  ).rejects.toThrow(/first sync failed/);

  expect(getPeer(db, "s3://bucket/metahub")).toBeNull();
});

test("addAndSyncStoragePeer restores an existing peer when first sync fails", async () => {
  const db = makeDb();
  const bucket = new TestBucket();
  bucket.failList = true;
  setStorageClientFactory(() => bucket);
  const url = "s3://bucket/metahub";
  addStoragePeer(db, { url, config: s3Config("https://old.example"), label: "old" });

  await expect(
    addAndSyncStoragePeer(db, {
      endpoint: "https://new.example",
      bucket: "bucket",
      accessKeyId: "id",
      secretAccessKey: "secret",
      encrypt: false,
      label: "new",
    }),
  ).rejects.toThrow(/first sync failed/);

  const row = getPeer(db, url)!;
  expect(row.label).toBe("old");
  expect((JSON.parse(row.config!) as S3Config).endpoint).toBe("https://old.example");
});

// ---- rotate + recovery-code join -----------------------------------------------

const BUCKET_URL = "s3://bucket/metahub";

function encConfig(K: Uint8Array, over: Partial<S3Config> = {}): S3Config {
  return { ...s3Config(), encrypt: true, masterKey: toB64(K), ...over };
}

function makeNode(id: string): Database {
  const db = makeDb();
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return db;
}

/** Seed a bucket with an envelope + real encrypted segments from a source node. */
async function seedEncryptedBucket(bucket: TestBucket, K: Uint8Array, passphrase: string) {
  const src = makeNode("srcnode1");
  addStoragePeer(src, { url: BUCKET_URL, config: encConfig(K), label: "bucket" });
  createDatabase(src, { name: "Seeded" });
  await bucket.put(
    "metahub/spaces/default/keys/main.json",
    new TextEncoder().encode(JSON.stringify(await wrapMasterKey(K, passphrase))),
    { contentType: "application/json" },
  );
  await syncWithStorage(src, BUCKET_URL, bucket, encConfig(K));
  return src;
}

test("rotate: credential-validation failure mutates nothing (old keys keep working)", async () => {
  const K = generateMasterKey();
  const bucket = new TestBucket();
  setStorageClientFactory(() => bucket);
  await seedEncryptedBucket(bucket, K, "old-pass");
  const db = makeNode("rotnode1");
  addStoragePeer(db, { url: BUCKET_URL, config: encConfig(K), label: "bucket" });
  const before = getPeer(db, BUCKET_URL)!.config;

  bucket.failList = true;
  await expect(
    rotateStoragePeer(db, BUCKET_URL, { accessKeyId: "newid", secretAccessKey: "newsecret" }),
  ).rejects.toThrow(/new credentials failed/);
  bucket.failList = false;

  expect(getPeer(db, BUCKET_URL)!.config).toBe(before); // byte-identical
});

test("rotate: passphrase rewrap keeps K, old passphrase stops working, cursors preserved", async () => {
  const K = generateMasterKey();
  const bucket = new TestBucket();
  setStorageClientFactory(() => bucket);
  await seedEncryptedBucket(bucket, K, "old-pass");
  const db = makeNode("rotnode2");
  addStoragePeer(db, { url: BUCKET_URL, config: encConfig(K), label: "bucket" });
  await syncPeer(db, BUCKET_URL); // establish cursors
  const cursorsBefore = db.query("SELECT * FROM storage_cursors ORDER BY node_id").all();

  const r = await rotateStoragePeer(db, BUCKET_URL, { newPassphrase: "new-pass" });
  expect(r.rotatedPassphrase).toBe(true);
  expect(r.rotatedCredentials).toBe(false);
  expect(r.keyVerified).toBe("skipped"); // K came from this device's own config
  expect(r.sync.ok).toBe(true);

  const env = (await readMasterKeyEnvelope(bucket, encConfig(K)))!;
  expect([...(await unwrapMasterKey(env, "new-pass"))]).toEqual([...K]);
  await expect(unwrapMasterKey(env, "old-pass")).rejects.toThrow(/wrong passphrase/);
  // local config: same K, cursors untouched
  const after = JSON.parse(getPeer(db, BUCKET_URL)!.config!) as S3Config;
  expect(after.masterKey).toBe(toB64(K));
  expect(db.query("SELECT * FROM storage_cursors ORDER BY node_id").all()).toEqual(cursorsBefore);
});

test("rotate: one automatic retry on a concurrent rewrap CAS conflict", async () => {
  const K = generateMasterKey();
  const bucket = new TestBucket();
  setStorageClientFactory(() => bucket);
  await seedEncryptedBucket(bucket, K, "old-pass");
  const db = makeNode("rotnode3");
  addStoragePeer(db, { url: BUCKET_URL, config: encConfig(K), label: "bucket" });

  bucket.failIfMatchOnce = true; // first CAS put loses, retry wins
  const r = await rotateStoragePeer(db, BUCKET_URL, { newPassphrase: "new-pass" });
  expect(r.rotatedPassphrase).toBe(true);
  const env = (await readMasterKeyEnvelope(bucket, encConfig(K)))!;
  expect([...(await unwrapMasterKey(env, "new-pass"))]).toEqual([...K]);
});

test("rotate: re-running the same command after a crash converges (idempotent)", async () => {
  const K = generateMasterKey();
  const bucket = new TestBucket();
  setStorageClientFactory(() => bucket);
  await seedEncryptedBucket(bucket, K, "old-pass");
  const db = makeNode("rotnode4");
  addStoragePeer(db, { url: BUCKET_URL, config: encConfig(K), label: "bucket" });

  const input = { accessKeyId: "newid", secretAccessKey: "newsecret", newPassphrase: "new-pass" };
  await rotateStoragePeer(db, BUCKET_URL, input);
  // "crash between rewrap and persist" is a strict subset of a full second run
  const r2 = await rotateStoragePeer(db, BUCKET_URL, input);
  expect(r2.rotatedCredentials).toBe(true);
  const after = JSON.parse(getPeer(db, BUCKET_URL)!.config!) as S3Config;
  expect(after.accessKeyId).toBe("newid");
  expect(after.masterKey).toBe(toB64(K));
  const env = (await readMasterKeyEnvelope(bucket, encConfig(K)))!;
  expect([...(await unwrapMasterKey(env, "new-pass"))]).toEqual([...K]);
  // outcome's enroll code round-trips the NEW credentials
  const enrolled = decodeEnroll(r2.enroll);
  expect(enrolled.accessKeyId).toBe("newid");
  expect(enrolled.secretAccessKey).toBe("newsecret");
});

test("rotate: missing local key + recovery code heals config; wrong-bucket code refused", async () => {
  const K = generateMasterKey();
  const bucket = new TestBucket();
  setStorageClientFactory(() => bucket);
  await seedEncryptedBucket(bucket, K, "old-pass");
  const db = makeNode("rotnode5");
  const noKey = encConfig(K);
  delete (noKey as Partial<S3Config>).masterKey;
  addStoragePeer(db, { url: BUCKET_URL, config: noKey, label: "bucket" });

  // wrong bucket's (otherwise valid) key → auth, envelope untouched
  const wrongCode = await encodeRecoveryCode(generateMasterKey());
  await expect(
    rotateStoragePeer(db, BUCKET_URL, { newPassphrase: "np", recoveryCode: wrongCode }),
  ).rejects.toThrow(/does not match this bucket/);

  const r = await rotateStoragePeer(db, BUCKET_URL, {
    newPassphrase: "new-pass",
    recoveryCode: await encodeRecoveryCode(K),
  });
  expect(r.keyVerified).toBe("verified");
  const after = JSON.parse(getPeer(db, BUCKET_URL)!.config!) as S3Config;
  expect(after.masterKey).toBe(toB64(K)); // healed
});

test("recovery-code join: verifies against ciphertext, never writes keys/main.json", async () => {
  const K = generateMasterKey();
  const bucket = new TestBucket();
  setStorageClientFactory(() => bucket);
  await seedEncryptedBucket(bucket, K, "old-pass");
  // simulate a deleted/lost envelope: recovery join must not recreate it
  await bucket.del("metahub/spaces/default/keys/main.json");
  const db = makeNode("joinnode1");

  const { url, sync } = await addAndSyncStoragePeer(db, {
    endpoint: "https://old.example",
    bucket: "bucket",
    accessKeyId: "id",
    secretAccessKey: "secret",
    encrypt: true,
    recoveryCode: await encodeRecoveryCode(K),
    publish: false,
    priority: 10,
  });
  expect(sync.ok).toBe(true);
  expect(sync.pulled).toBeGreaterThan(0); // hydrated the seeded data
  expect(bucket.store.has("metahub/spaces/default/keys/main.json")).toBe(false);
  expect((JSON.parse(getPeer(db, url)!.config!) as S3Config).masterKey).toBe(toB64(K));

  // a wrong code is rejected up front and nothing is persisted
  const db2 = makeNode("joinnode2");
  await expect(
    addAndSyncStoragePeer(db2, {
      endpoint: "https://old.example",
      bucket: "bucket",
      accessKeyId: "id",
      secretAccessKey: "secret",
      encrypt: true,
      recoveryCode: await encodeRecoveryCode(generateMasterKey()),
    }),
  ).rejects.toThrow(/does not match this bucket/);
  expect(getPeer(db2, url)).toBeNull();
});

test("rotate preflight errors: not_found, creds-pair, plaintext passphrase, nothing-to-do", async () => {
  const db = makeNode("rotnode6");
  await expect(rotateStoragePeer(db, "s3://nope/x", {})).rejects.toThrow(/no S3 storage peer/);

  const bucket = new TestBucket();
  setStorageClientFactory(() => bucket);
  addStoragePeer(db, { url: BUCKET_URL, config: s3Config(), label: "b" }); // plaintext
  await expect(
    rotateStoragePeer(db, BUCKET_URL, { accessKeyId: "only-half" }),
  ).rejects.toThrow(/both the access key id and secret/);
  await expect(
    rotateStoragePeer(db, BUCKET_URL, { newPassphrase: "x" }),
  ).rejects.toThrow(/not encrypted/);
  await expect(rotateStoragePeer(db, BUCKET_URL, {})).rejects.toThrow(/nothing to rotate/);
});
