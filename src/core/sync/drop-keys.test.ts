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

/** In-memory StorageClient with real If-None-Match AND If-Match (etag CAS). */
class FakeStorageClient implements StorageClient {
  store = new Map<string, { body: Uint8Array; etag: string }>();
  private seq = 0;
  async list(prefix: string): Promise<StorageObject[]> {
    return [...this.store.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => ({ key, etag: v.etag }));
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(key)?.body ?? null;
  }
  async put(key: string, body: Uint8Array, opts?: StoragePutOpts): Promise<void> {
    const cur = this.store.get(key);
    if (opts?.ifNoneMatch && cur) throw new MhError("conflict", "exists");
    if (opts?.ifMatch && cur?.etag !== opts.ifMatch) throw new MhError("conflict", "etag mismatch");
    this.store.set(key, { body, etag: `etag-${++this.seq}` });
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

test("adopting a bucket keeps a local-only key (union, not clobber) — in-flight mail still opens (F22a)", async () => {
  const client = new FakeStorageClient();
  const mk = generateMasterKey();
  // db1 provisions the bucket keyring (KA).
  const db1 = makeDb("dev1");
  await ensureDropKeys(db1, { bucket: bucketFor(client, mk) });

  // db2 generated its OWN keyring (KB) locally BEFORE attaching this bucket, and
  // a visitor already sealed mail to KB's pk.
  const db2 = makeDb("dev2");
  const krB = await ensureDropKeys(db2, { bucket: null });
  const kb = activeDropKey(krB);
  const sealed = await seal(fromB64(kb.pk), new TextEncoder().encode("sealed to KB"));

  // Attaching the bucket must UNION (keep KB), not overwrite it away.
  const adopted = await ensureDropKeys(db2, { bucket: bucketFor(client, mk) });
  expect(findDropKey(adopted, kb.key_id)).toBeDefined();
  // KB survives locally AND opens its in-flight envelope (now wrapped).
  const sk = await dropKeySecret(db2, findDropKey(adopted, kb.key_id)!, { bucket: bucketFor(client, mk) });
  expect(new TextDecoder().decode(await openSealed(sk, fromB64(kb.pk), sealed))).toBe("sealed to KB");
  // and the bucket now advertises KB too, so another device can decrypt it.
  const dev3 = await ensureDropKeys(makeDb("dev3"), { bucket: bucketFor(client, mk) });
  expect(findDropKey(dev3, kb.key_id)).toBeDefined();
});

test("concurrent rotation converges via If-Match CAS: both fresh keys survive (F22c)", async () => {
  const client = new FakeStorageClient();
  const mk = generateMasterKey();
  const db1 = makeDb("dev1");
  const db2 = makeDb("dev2");
  await ensureDropKeys(db1, { bucket: bucketFor(client, mk) });
  await ensureDropKeys(db2, { bucket: bucketFor(client, mk) }); // both adopt KA

  // Force a true interleave: when db2's rotate makes its first conditional PUT,
  // slip db1's whole rotation in just before it — db2's CAS then 412s and must
  // re-read + merge + retry. Both fresh keys must end up in the bucket keyring.
  const realPut = client.put.bind(client);
  let sneaked = false;
  client.put = async (key, body, opts) => {
    if (!sneaked && opts?.ifMatch) {
      sneaked = true;
      await rotateDropKeys(db1, { bucket: bucketFor(client, mk) });
    }
    return realPut(key, body, opts);
  };
  const r2 = await rotateDropKeys(db2, { bucket: bucketFor(client, mk) });
  client.put = realPut;

  const finalKr = await ensureDropKeys(makeDb("dev3"), { bucket: bucketFor(client, mk) });
  const active = finalKr.keys.filter((k) => !k.retired).map((k) => k.key_id);
  expect(active).toContain(r2.active.key_id); // db2's fresh key was NOT clobbered
  expect(finalKr.keys.length).toBeGreaterThanOrEqual(3); // KA + db1-fresh + db2-fresh
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
