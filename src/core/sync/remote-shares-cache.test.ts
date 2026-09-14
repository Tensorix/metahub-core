import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { addPeer, addStoragePeer } from "./peers.ts";
import {
  setStorageClientFactory,
  type S3Config,
  type StorageClient,
  type StorageObject,
  type StoragePutOpts,
} from "./storage.ts";
import {
  cachedRemoteShares,
  dropRemoteShare,
  findCachedBucketShare,
  onRemoteSharesChanged,
  primeRemoteShare,
  refreshRemoteShares,
  refreshRemoteSource,
  remoteShareSources,
} from "./remote-shares-cache.ts";
import { listSharesAggregated, listSharesLocal } from "./share-actions.ts";

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

const CONFIG = {
  endpoint: "https://x.example",
  bucket: "b",
  prefix: "mh",
  region: "auto",
  accessKeyId: "ak",
  secretAccessKey: "sk",
} as S3Config;
const BUCKET_URL = "s3://b/mh";

class FakeBucket implements StorageClient {
  store = new Map<string, Uint8Array>();
  lists = 0;
  fail = false;
  async list(prefix: string, startAfter?: string, delimiter?: string): Promise<StorageObject[]> {
    this.lists++;
    if (this.fail) throw new Error("bucket offline");
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix) && (startAfter == null || k > startAfter))
      .sort();
    if (!delimiter) return keys.map((key) => ({ key }));
    const out: StorageObject[] = [];
    const prefixes = new Set<string>();
    for (const k of keys) {
      const rest = k.slice(prefix.length);
      const i = rest.indexOf(delimiter);
      if (i >= 0) prefixes.add(prefix + rest.slice(0, i + 1));
      else out.push({ key: k });
    }
    for (const p of prefixes) out.push({ key: p });
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  }
  async get(key: string): Promise<Uint8Array | null> {
    if (this.fail) throw new Error("bucket offline");
    return this.store.get(key) ?? null;
  }
  async put(key: string, body: Uint8Array, _opts?: StoragePutOpts): Promise<void> {
    this.store.set(key, body);
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
  putMeta(slug: string, targetId: string): void {
    const meta = {
      v: 1,
      slug,
      kind: "doc",
      target_id: targetId,
      title: `Doc ${slug}`,
      permission: "view",
      created_at: 1000,
      presign_exp: 2000,
      has_password: false,
      objects: [],
      key: "",
      content_updated_at: 1500,
    };
    this.store.set(`mh/shares/${slug}/meta.json`, new TextEncoder().encode(JSON.stringify(meta)));
  }
}

function makeDb(): Database {
  const d = new Database(":memory:");
  runSchema(d);
  d.query("INSERT INTO meta (key,value) VALUES ('node_id','cache-test')").run();
  addStoragePeer(d, { url: BUCKET_URL, config: CONFIG, label: "桶A" });
  return d;
}

test("cached listing answers from memory and refreshes the bucket in the background", async () => {
  const bucket = new FakeBucket();
  bucket.putMeta("abc", "doc_1");
  setStorageClientFactory(() => bucket);
  const db = makeDb();
  let notified = 0;
  const off = onRemoteSharesChanged(() => notified++);

  expect(cachedRemoteShares(db)).toEqual([]);
  expect(bucket.lists).toBe(1);
  await refreshRemoteShares(db);
  const items = cachedRemoteShares(db);
  expect(items.map((i) => [i.slug, i.sourceKind, i.source])).toEqual([["abc", "bucket", "桶 桶A"]]);
  expect(notified).toBe(1);

  await refreshRemoteSource(db, remoteShareSources(db)[0]!);
  expect(notified).toBe(1);
  expect(cachedRemoteShares(db).length).toBe(1);
  expect(bucket.lists).toBe(2);
  off();
});

test("listSharesLocal cached mode never touches the bucket; fresh mode does", async () => {
  const bucket = new FakeBucket();
  bucket.putMeta("abc", "doc_1");
  setStorageClientFactory(() => bucket);
  const db = makeDb();
  await refreshRemoteShares(db);
  const before = bucket.lists;
  const cached = await listSharesLocal(db, undefined, { mode: "cached" });
  expect(cached.map((i) => i.slug)).toEqual(["abc"]);
  expect(bucket.lists).toBe(before);
  const fresh = await listSharesLocal(db);
  expect(fresh.map((i) => i.slug)).toEqual(["abc"]);
  expect(bucket.lists).toBe(before + 1);
  expect((await listSharesLocal(db, "doc_other", { mode: "cached" })).length).toBe(0);
});

test("prime/drop edit the cache immediately and findCachedBucketShare resolves the owner", async () => {
  const bucket = new FakeBucket();
  setStorageClientFactory(() => bucket);
  const db = makeDb();
  await refreshRemoteShares(db);
  expect(findCachedBucketShare(db, "new")).toBeNull();
  primeRemoteShare(db, BUCKET_URL, {
    slug: "new",
    kind: "doc",
    target_id: "doc_2",
    title: "New",
    permission: "view",
    transport: "s3",
    source: "桶 桶A",
    sourceKind: "bucket",
    hosting: "s3",
    expiresAt: 1,
    hasPassword: false,
  });
  expect(findCachedBucketShare(db, "new")?.source.url).toBe(BUCKET_URL);
  expect(cachedRemoteShares(db, "doc_2").length).toBe(1);
  dropRemoteShare(db, BUCKET_URL, "new");
  expect(findCachedBucketShare(db, "new")).toBeNull();
});

test("a failed refresh keeps the last-known rows", async () => {
  const bucket = new FakeBucket();
  bucket.putMeta("abc", "doc_1");
  setStorageClientFactory(() => bucket);
  const db = makeDb();
  await refreshRemoteShares(db);
  bucket.fail = true;
  await refreshRemoteSource(db, remoteShareSources(db)[0]!);
  expect(cachedRemoteShares(db).map((i) => i.slug)).toEqual(["abc"]);
});

test("paired peers are cached too and the aggregated cached listing skips the fan-out", async () => {
  const bucket = new FakeBucket();
  setStorageClientFactory(() => bucket);
  const db = makeDb();
  addPeer(db, { url: "https://peer.example", token: "t", label: "Peer" });
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return Response.json([
      {
        slug: "p1",
        kind: "doc",
        target_id: "doc_9",
        title: "Peer doc",
        permission: "view",
        transport: "server",
        source: "本机服务器",
        sourceKind: "server",
        expiresAt: null,
        hasPassword: false,
        url: "/share/p1",
      },
    ]);
  }) as unknown as typeof fetch;

  await refreshRemoteShares(db);
  expect(fetches).toBe(1);
  const all = await listSharesAggregated(db, undefined, { mode: "cached" });
  expect(fetches).toBe(1);
  const peer = all.find((i) => i.slug === "p1")!;
  expect(peer.sourceKind).toBe("peer");
  expect(peer.sourceUrl).toBe("https://peer.example");
  expect(peer.url).toBe("https://peer.example/share/p1");
});
