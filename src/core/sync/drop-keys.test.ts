import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { MhError, errorCode } from "../errors.ts";
import { generateMasterKey, fromB64 } from "./e2ee.ts";
import type { StorageClient, StorageObject, StoragePutOpts } from "./storage.ts";
import { seal, openSealed } from "./seal.ts";
import {
  ensureDropKeys,
  rotateDropKeys,
  activeDropKey,
  findDropKey,
  dropKeySecret,
  getLocalDropKeyring,
  type DropBucket,
} from "./drop-keys.ts";

function makeDb(node = "hostnode"): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(node);
  return db;
}

/** In-memory StorageClient with real If-None-Match semantics. */
class FakeStorageClient implements StorageClient {
  store = new Map<string, Uint8Array>();
  async list(prefix: string): Promise<StorageObject[]> {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key }));
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, body: Uint8Array, opts?: StoragePutOpts): Promise<void> {
    if (opts?.ifNoneMatch && this.store.has(key)) throw new MhError("conflict", "exists");
    this.store.set(key, body);
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function bucketFor(client: FakeStorageClient, masterKey: Uint8Array): DropBucket {
  return {
    peerUrl: "s3://host/bucket/metahub",
    config: { endpoint: "https://x", region: "auto", bucket: "b", prefix: "metahub", accessKeyId: "a", secretAccessKey: "s", encrypt: true },
    base: "metahub/spaces/default",
    keyPath: "metahub/spaces/default/keys/drop.json",
    masterKey,
    client: () => client,
  };
}

test("no bucket: keyring provisions locally (raw sk) and is stable", async () => {
  const db = makeDb();
  const kr1 = await ensureDropKeys(db, { bucket: null });
  expect(kr1.keys).toHaveLength(1);
  expect(kr1.keys[0]!.wrapped).toBe(false);
  const kr2 = await ensureDropKeys(db, { bucket: null });
  expect(kr2.keys[0]!.key_id).toBe(kr1.keys[0]!.key_id);
  // the local key opens what was sealed to its pk
  const key = activeDropKey(kr1);
  const sealed = await seal(fromB64(key.pk), new TextEncoder().encode("mail"));
  const sk = await dropKeySecret(db, key, { bucket: null });
  expect(new TextDecoder().decode(await openSealed(sk, fromB64(key.pk), sealed))).toBe("mail");
});

test("bucket: second device adopts the first device's keyring (bucket authoritative)", async () => {
  const client = new FakeStorageClient();
  const mk = generateMasterKey();
  const db1 = makeDb("nodeone1");
  const db2 = makeDb("nodetwo2");
  const kr1 = await ensureDropKeys(db1, { bucket: bucketFor(client, mk) });
  expect(kr1.keys[0]!.wrapped).toBe(true);
  const kr2 = await ensureDropKeys(db2, { bucket: bucketFor(client, mk) });
  expect(kr2.keys[0]!.key_id).toBe(kr1.keys[0]!.key_id);
  // both devices decrypt with the shared master key
  const sk = await dropKeySecret(db2, activeDropKey(kr2), { bucket: bucketFor(client, mk) });
  expect(sk.byteLength).toBeGreaterThan(0);
  // local cache is populated
  expect(getLocalDropKeyring(db2)?.keys[0]!.key_id).toBe(kr1.keys[0]!.key_id);
});

test("first-create race: loser adopts the winner via If-None-Match conflict", async () => {
  const client = new FakeStorageClient();
  const mk = generateMasterKey();
  const winnerDb = makeDb("winnerno");
  const winner = await ensureDropKeys(winnerDb, { bucket: bucketFor(client, mk) });

  // Racing client: GET sees nothing (raced past), PUT hits the real store → conflict.
  const racing = new FakeStorageClient();
  racing.store = client.store;
  let firstGet = true;
  const origGet = racing.get.bind(racing);
  racing.get = async (key: string) => {
    if (firstGet) {
      firstGet = false;
      return null; // simulate: our GET ran before the winner's PUT landed
    }
    return origGet(key);
  };
  const loserDb = makeDb("loserno1");
  const adopted = await ensureDropKeys(loserDb, { bucket: bucketFor(racing, mk) });
  expect(adopted.keys[0]!.key_id).toBe(winner.keys[0]!.key_id);
});

test("rotation: old key retired but still opens; purge drops only the previously-retired", async () => {
  const client = new FakeStorageClient();
  const mk = generateMasterKey();
  const db = makeDb();
  const bucket = bucketFor(client, mk);
  const kr0 = await ensureDropKeys(db, { bucket });
  const gen0 = activeDropKey(kr0);
  const sealed = await seal(fromB64(gen0.pk), new TextEncoder().encode("in flight"));

  const r1 = await rotateDropKeys(db, { bucket });
  expect(r1.active.key_id).not.toBe(gen0.key_id);
  expect(r1.purged).toEqual([]);
  const retired = findDropKey(r1.keyring, gen0.key_id)!;
  expect(retired.retired).toBe(true);
  // the retired key still opens the in-flight envelope
  const sk = await dropKeySecret(db, retired, { bucket });
  expect(new TextDecoder().decode(await openSealed(sk, fromB64(retired.pk), sealed))).toBe("in flight");

  // second rotation with purge: gen0 (previously retired) goes, gen1 (just
  // retired now) survives — a purge can never orphan mail sealed a second ago.
  const r2 = await rotateDropKeys(db, { bucket, purgeRetired: true });
  expect(r2.purged).toEqual([gen0.key_id]);
  expect(findDropKey(r2.keyring, gen0.key_id)).toBeUndefined();
  expect(findDropKey(r2.keyring, r1.active.key_id)?.retired).toBe(true);
  expect(r2.keyring.keys).toHaveLength(2);
});

test("wrong master key cannot unwrap the private key (auth)", async () => {
  const client = new FakeStorageClient();
  const mkA = generateMasterKey();
  const db = makeDb();
  const kr = await ensureDropKeys(db, { bucket: bucketFor(client, mkA) });
  const mkB = generateMasterKey();
  let code: string | undefined;
  await dropKeySecret(db, activeDropKey(kr), { bucket: bucketFor(client, mkB) }).catch(
    (e) => (code = errorCode(e)),
  );
  expect(code).toBe("auth");
});
