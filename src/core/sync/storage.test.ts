import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { compactOplog } from "../compact.ts";
import { emit, emitFields, ingest, type Change } from "../crdt.ts";
import { createDatabase } from "../databases.ts";
import { createDocument, getDocument, updateDocument } from "../documents.ts";
import { MhError } from "../errors.ts";
import { generateMasterKey, toB64 } from "./e2ee.ts";
import {
  syncWithStorage,
  publishSnapshot,
  provisionMasterKey,
  type S3Config,
  type StorageClient,
  type StorageObject,
  type StoragePutOpts,
} from "./storage.ts";
import { isElectedPublisher } from "./publisher-lease.ts";

function makeNode(id: string): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  // Storage peers are addressed by a synthetic url; seed the row so push_cursor
  // updates have something to write to (addStoragePeer does this for real).
  db.query("INSERT INTO peers (url, kind, enabled) VALUES (?, 's3', 1)").run(PEER);
  return db;
}

const PEER = "s3://bucket/mh";

/** In-memory bucket: list/get/put/del over a Map, ordered by key like S3. */
class FakeBucket implements StorageClient {
  store = new Map<string, Uint8Array>();
  async list(prefix: string, startAfter?: string, delimiter?: string): Promise<StorageObject[]> {
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix) && (startAfter == null || k > startAfter))
      .sort();
    if (!delimiter) return keys.map((key) => ({ key }));
    // Collapse one level into common prefixes, like S3's delimiter listing.
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
    return this.store.get(key) ?? null;
  }
  async put(key: string, body: Uint8Array, opts?: StoragePutOpts): Promise<void> {
    if (opts?.ifNoneMatch && this.store.has(key))
      throw new MhError("conflict", `S3 object already exists: ${key}`);
    this.store.set(key, body);
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function headState(db: Database) {
  const norm = (rows: any[]) =>
    rows.map((r) => ({
      ...r,
      data:
        r.data != null
          ? JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(r.data || "{}")).sort()))
          : r.data,
    }));
  return {
    databases: db.query("SELECT * FROM databases ORDER BY id").all(),
    records: norm(db.query("SELECT * FROM records ORDER BY id").all()),
    documents: db.query("SELECT * FROM documents ORDER BY id").all(),
  };
}

function cfg(masterKey: Uint8Array | null): S3Config {
  return {
    endpoint: "",
    region: "",
    bucket: "bucket",
    prefix: "mh",
    accessKeyId: "",
    secretAccessKey: "",
    encrypt: masterKey != null,
    masterKey: masterKey ? toB64(masterKey) : undefined,
  };
}

test("two nodes converge through the bucket without being online together", async () => {
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA");
  const b = makeNode("nodeBBBB");
  const bucket = new FakeBucket();

  // A works first (B "offline"): create a db + record, push to bucket.
  const dbId = createDatabase(a, { name: "Tasks" }).id;
  emitFields(a, "records", "rec-1", { database_id: dbId, "title-x": "write docs" });
  await syncWithStorage(a, PEER, bucket, cfg(K));

  // Later B comes online (A now "offline"): pulls A's segment, then edits + pushes.
  await syncWithStorage(b, PEER, bucket, cfg(K));
  expect(headState(b)).toEqual(headState(a));
  emit(b, "records", "rec-1", "title-x", "write the docs");
  await syncWithStorage(b, PEER, bucket, cfg(K));

  // A comes back, pulls B's change → both converge byte-for-byte.
  await syncWithStorage(a, PEER, bucket, cfg(K));
  expect(headState(a)).toEqual(headState(b));
  const rec = a.query("SELECT data FROM records WHERE id = 'rec-1'").get() as { data: string };
  expect(JSON.parse(rec.data)["title-x"]).toBe("write the docs"); // B's edit won
});

test("re-syncing is idempotent (no double-apply)", async () => {
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA");
  const b = makeNode("nodeBBBB");
  const bucket = new FakeBucket();
  createDatabase(a, { name: "X" });
  await syncWithStorage(a, PEER, bucket, cfg(K));
  await syncWithStorage(b, PEER, bucket, cfg(K));
  const once = headState(b);
  await syncWithStorage(b, PEER, bucket, cfg(K));
  await syncWithStorage(b, PEER, bucket, cfg(K));
  expect(headState(b)).toEqual(once);
});

test("plaintext mode (no encryption) also round-trips", async () => {
  const a = makeNode("nodeAAAA");
  const b = makeNode("nodeBBBB");
  const bucket = new FakeBucket();
  createDatabase(a, { name: "Plain" });
  await syncWithStorage(a, PEER, bucket, cfg(null));
  await syncWithStorage(b, PEER, bucket, cfg(null));
  expect(headState(b)).toEqual(headState(a));
});

test("a fresh node hydrates from snapshot + tail after truncation", async () => {
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA");
  const bucket = new FakeBucket();

  // Build some history, push it as segments.
  const dbId = createDatabase(a, { name: "Notes" }).id;
  const doc = createDocument(a, { title: "Doc", body: "v1", database_id: dbId });
  await syncWithStorage(a, PEER, bucket, cfg(K));
  updateDocument(a, doc.id, { body: "v2" });
  await syncWithStorage(a, PEER, bucket, cfg(K));

  // Publish a snapshot and fully truncate A's segments (retainSegments:0 = the
  // legacy collapse; ⑤c retention is covered separately).
  const snap = await publishSnapshot(a, bucket, cfg(K), 0);
  expect(snap).not.toBeNull();
  const segsAfter = (await bucket.list("mh/spaces/default/oplog/nodeAAAA/")).filter((o) =>
    o.key.endsWith(".seg"),
  );
  expect(segsAfter.length).toBe(0); // own segments truncated

  // More edits after the snapshot → a fresh tail segment.
  updateDocument(a, doc.id, { body: "v3" });
  await syncWithStorage(a, PEER, bucket, cfg(K));

  // A brand-new node with an empty DB pulls: snapshot + tail = A's head state.
  const c = makeNode("nodeCCCC");
  await syncWithStorage(c, PEER, bucket, cfg(K));
  expect(headState(c)).toEqual(headState(a));
  expect(getDocument(c, doc.id)!.body).toBe("v3");
});

test("compaction + VACUUM does not strand new writes from the push cursor", async () => {
  // Regression for the rowid-cursor hole: compaction's VACUUM renumbers a
  // legacy table's rowids 1..N; a peer's push_cursor then sat above the new
  // MAX(rowid) and every later write was silently never pushed. With the
  // AUTOINCREMENT seq this must converge.
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA");
  const b = makeNode("nodeBBBB");
  const bucket = new FakeBucket();

  // Many overwrites of one register so compaction has superseded rows to delete
  // (the deletions are what make VACUUM shrink the id space).
  const dbId = createDatabase(a, { name: "Tasks" }).id;
  emit(a, "records", "rec-1", "database_id", dbId);
  for (let i = 0; i < 20; i++) emit(a, "records", "rec-1", "title", `v${i}`);
  await syncWithStorage(a, PEER, bucket, cfg(K)); // push_cursor → high water

  // Collapse history (keepDays:0) AND VACUUM. Pre-fix this renumbered the
  // implicit rowids and stranded the cursor; with the AUTOINCREMENT seq the max
  // id is preserved instead. Assert compaction actually deleted superseded rows
  // (so VACUUM had gaps to reclaim) rather than the now-stable MAX(seq).
  const n = (db: Database) =>
    (db.query("SELECT COUNT(*) AS n FROM crdt_changes").get() as { n: number }).n;
  const before = n(a);
  compactOplog(a, { keepDays: 0, now: Date.now() + 86_400_000, vacuum: true });
  expect(n(a)).toBeLessThan(before); // superseded title versions were compacted

  // A write produced AFTER the vacuum must still reach the bucket and B.
  emit(a, "records", "rec-1", "after_vacuum", "yes");
  await syncWithStorage(a, PEER, bucket, cfg(K));
  await syncWithStorage(b, PEER, bucket, cfg(K));

  const rec = b.query("SELECT data FROM records WHERE id = 'rec-1'").get() as { data: string } | null;
  expect(rec).not.toBeNull();
  const data = JSON.parse(rec!.data);
  expect(data.after_vacuum).toBe("yes"); // post-vacuum write was not stranded
  expect(data.title).toBe("v19"); // and the pre-vacuum winner converged too
});

test("publisher snapshotEverySegments threshold triggers auto snapshot + truncation", async () => {
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA");
  const bucket = new FakeBucket();
  const config = cfg(K);

  // Create the initial publisher baseline, then make the threshold path (not the
  // empty-bucket publisher path) collapse two later segments.
  createDatabase(a, { name: "seed" });
  await syncWithStorage(a, PEER, bucket, config, {
    publish: true,
    snapshotRetainSegments: 0,
  });

  // Each later sync round with new ops writes one segment; threshold 2 collapses them.
  // retainSegments:0 forces a full collapse so we can assert truncation here.
  const opts = {
    publish: true,
    snapshotEverySegments: 2,
    snapshotRetainSegments: 0,
    snapshotMinDelta: 9999,
    snapshotDeltaRatio: 9999,
    snapshotMaxIntervalMs: Number.MAX_SAFE_INTEGER,
  };
  createDatabase(a, { name: "1" });
  await syncWithStorage(a, PEER, bucket, config, opts);
  createDatabase(a, { name: "2" });
  await syncWithStorage(a, PEER, bucket, config, opts);

  const snaps = (await bucket.list("mh/spaces/default/snapshot/")).filter((o) =>
    o.key.endsWith(".snap"),
  );
  expect(snaps.length).toBeGreaterThanOrEqual(1);
  const segs = (await bucket.list("mh/spaces/default/oplog/nodeAAAA/")).filter((o) =>
    o.key.endsWith(".seg"),
  );
  expect(segs.length).toBe(0); // collapsed into the snapshot
});

test("publish:false never writes a whole-hub snapshot at the segment threshold", async () => {
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA");
  const bucket = new FakeBucket();
  const config = cfg(K);
  const opts = { publish: false, snapshotEverySegments: 1, snapshotRetainSegments: 0 };

  createDatabase(a, { name: "OnlySegments" });
  await syncWithStorage(a, PEER, bucket, config, opts);

  const snaps = (await bucket.list("mh/spaces/default/snapshot/")).filter((o) =>
    o.key.endsWith(".snap"),
  );
  expect(snaps.length).toBe(0);
  const segs = (await bucket.list("mh/spaces/default/oplog/nodeAAAA/")).filter((o) =>
    o.key.endsWith(".seg"),
  );
  expect(segs.length).toBe(1);
});

test("publisher writes a whole-hub snapshot even with no own ops (empty-bucket fix)", async () => {
  // Regression for the "attached a bucket but it stays empty" footgun: a node
  // that holds the full hub via *ingest* (a hydrated replica / a server absorbing
  // window writes) has nothing of its OWN to push (onlyNode → 0), but as the
  // designated publisher it must still mirror the whole hub so other devices and
  // fresh nodes get a complete bucket.
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA"); // authoring node
  const p = makeNode("nodePPPP"); // publisher that only mirrors (authors nothing)
  const bucket = new FakeBucket();

  // A authors + pushes its own segments — no snapshot yet.
  const dbId = createDatabase(a, { name: "Tasks" }).id;
  emitFields(a, "records", "rec-1", { database_id: dbId, title: "hi" });
  await syncWithStorage(a, PEER, bucket, cfg(K));
  let snaps = (await bucket.list("mh/spaces/default/snapshot/")).filter((o) => o.key.endsWith(".snap"));
  expect(snaps.length).toBe(0);

  // P pulls A's data (now holds the full hub) and, as publisher, snapshots it
  // this same round — despite authoring nothing of its own.
  const r = await syncWithStorage(p, PEER, bucket, cfg(K), { publish: true });
  expect(r.pushed).toBe(0); // P authored nothing
  snaps = (await bucket.list("mh/spaces/default/snapshot/")).filter((o) => o.key.endsWith(".snap"));
  expect(snaps.length).toBe(1); // …but the whole-hub snapshot was published

  // A brand-new node hydrates the COMPLETE hub from the bucket.
  const c = makeNode("nodeCCCC");
  await syncWithStorage(c, PEER, bucket, cfg(K));
  expect(headState(c)).toEqual(headState(a));
});

// ---- A0-2: master-key first-init race -------------------------------------

const ENC: S3Config = {
  endpoint: "",
  region: "",
  bucket: "bucket",
  prefix: "mh",
  accessKeyId: "",
  secretAccessKey: "",
  encrypt: true,
};

test("provisionMasterKey: a second device adopts the existing key (no clobber)", async () => {
  const bucket = new FakeBucket();
  const k1 = await provisionMasterKey(bucket, ENC, "shared-pass");
  const k2 = await provisionMasterKey(bucket, ENC, "shared-pass");
  expect(k1).not.toBeNull();
  expect(k2).toBe(k1); // adopted via the GET-existing fast path
});

test("provisionMasterKey: If-None-Match makes a concurrent first-init adopt the winner", async () => {
  const bucket = new FakeBucket();
  const kA = await provisionMasterKey(bucket, ENC, "shared-pass"); // A wins, key now present

  // B raced: its first GET missed (read before A's write landed), so it
  // generates its own key and must hit the conditional-PUT conflict, then adopt.
  let firstGet = true;
  const racing: StorageClient = {
    list: (...a) => bucket.list(...a),
    get: (key) => {
      if (firstGet && key.endsWith("keys/main.json")) {
        firstGet = false;
        return Promise.resolve(null);
      }
      return bucket.get(key);
    },
    put: (...a) => bucket.put(...a),
    del: (...a) => bucket.del(...a),
  };
  const kB = await provisionMasterKey(racing, ENC, "shared-pass");
  expect(kB).toBe(kA); // B adopted A's key instead of overwriting it
});

// ---- A0-3: HEAD written before its segment --------------------------------

test("push writes HEAD before its segment (a crash can't leave HEAD behind a seg)", async () => {
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA");
  const order: string[] = [];
  const rec = new FakeBucket();
  const wrapped: StorageClient = {
    list: (...x) => rec.list(...x),
    get: (...x) => rec.get(...x),
    del: (...x) => rec.del(...x),
    put: (key, body, opts) => {
      if (key.endsWith("/HEAD")) order.push("HEAD");
      else if (key.endsWith(".seg")) order.push("SEG");
      return rec.put(key, body, opts);
    },
  };
  createDatabase(a, { name: "X" });
  await syncWithStorage(a, PEER, wrapped, cfg(K));
  expect(order).toEqual(["HEAD", "SEG"]);
});

test("a missing segment after HEAD (crash window) doesn't break pull and self-heals", async () => {
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA");
  const b = makeNode("nodeBBBB");
  const bucket = new FakeBucket();
  let crashOnce = true;
  const flaky: StorageClient = {
    list: (...x) => bucket.list(...x),
    get: (...x) => bucket.get(...x),
    del: (...x) => bucket.del(...x),
    put: (key, body, opts) => {
      if (crashOnce && key.endsWith(".seg")) {
        crashOnce = false; // HEAD already written; the segment write "crashes"
        throw new Error("simulated crash after HEAD");
      }
      return bucket.put(key, body, opts);
    },
  };
  createDatabase(a, { name: "X" });
  await expect(syncWithStorage(a, PEER, flaky, cfg(K))).rejects.toThrow(); // seg lost, cursor not advanced

  // B pulls while HEAD points at a missing segment: no crash, nothing applied.
  await syncWithStorage(b, PEER, flaky, cfg(K));
  expect((b.query("SELECT COUNT(*) AS n FROM databases").get() as { n: number }).n).toBe(0);

  // A retries (cursor untouched) → segment lands → B converges.
  await syncWithStorage(a, PEER, flaky, cfg(K));
  await syncWithStorage(b, PEER, flaky, cfg(K));
  expect(headState(b)).toEqual(headState(a));
});

// ---- A0-4: snapshot key uniqueness + set-based consumption ----------------

test("snapshots sharing a max-HLC but differing in content get distinct keys, both applied", async () => {
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA");
  const b = makeNode("nodeBBBB");
  const bucket = new FakeBucket();

  // Divergent low-HLC own changes, then a shared highest-HLC change X ingested
  // into both → both compute the same maxHlc but different winner sets.
  emit(a, "records", "rec-A", "fa", "1");
  emit(b, "records", "rec-B", "fb", "2");
  const X: Change = {
    hlc: "999999999999999-0000-sharedXX",
    node_id: "sharedXX",
    dataset: "records",
    row_id: "rec-X",
    col: "fx",
    value: JSON.stringify("3"),
  };
  ingest(a, [X]);
  ingest(b, [X]);

  const sa = await publishSnapshot(a, bucket, cfg(K));
  const sb = await publishSnapshot(b, bucket, cfg(K));
  expect(sa!.key).not.toBe(sb!.key); // same maxHlc, different content → distinct keys
  const snaps = (await bucket.list("mh/spaces/default/snapshot/")).filter((o) =>
    o.key.endsWith(".snap"),
  );
  expect(snaps.length).toBe(2); // neither GC'd the other (same frontier)

  // A fresh consumer must ingest BOTH (a single-latest cursor would skip one).
  const c = makeNode("nodeCCCC");
  await syncWithStorage(c, PEER, bucket, cfg(K));
  const cols = (c.query("SELECT col FROM crdt_changes ORDER BY col").all() as { col: string }[]).map(
    (r) => r.col,
  );
  expect(cols).toContain("fa");
  expect(cols).toContain("fb");
  expect(cols).toContain("fx");
});

test("publishSnapshot is content-addressed and GCs strictly-older snapshots", async () => {
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA");
  const bucket = new FakeBucket();
  createDatabase(a, { name: "One" });
  const s1 = await publishSnapshot(a, bucket, cfg(K));
  createDatabase(a, { name: "Two" });
  const s2 = await publishSnapshot(a, bucket, cfg(K));
  expect(s2!.key).not.toBe(s1!.key);
  const snaps = (await bucket.list("mh/spaces/default/snapshot/")).filter((o) =>
    o.key.endsWith(".snap"),
  );
  expect(snaps.length).toBe(1); // the older snapshot was reclaimed
  expect(snaps[0]!.key).toBe(s2!.key);
});

// ---- F: publisher election (best-effort lease) ----------------------------

test("publisher election: highest priority wins, then fails over when it expires", async () => {
  const bucket = new FakeBucket();
  // Unique base so the module-level heartbeat throttle map can't collide across tests.
  const base = `mh-${Math.random().toString(36).slice(2)}/spaces/default`;
  const t0 = 1_700_000_000_000;

  // A (priority 100) and B (priority 10) both heartbeat at t0.
  expect(await isElectedPublisher(bucket, base, "nodeAAAA", 100, t0)).toBe(true); // A alone so far
  expect(await isElectedPublisher(bucket, base, "nodeBBBB", 10, t0)).toBe(false); // sees A(100) → stands by

  // A goes silent; past the TTL its lease expires → duty fails over to B.
  const later = t0 + 6 * 60_000;
  expect(await isElectedPublisher(bucket, base, "nodeBBBB", 10, later)).toBe(true);
});

// ---- A1: push batching ----------------------------------------------------

test("push batching defers small bursts and force flushes them", async () => {
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA");
  const bucket = new FakeBucket();
  const batched = { minPushChanges: 100, maxPushAgeMs: 999_999 }; // never auto-flush a small batch

  createDatabase(a, { name: "X" }); // a handful of changes, well under 100
  await syncWithStorage(a, PEER, bucket, cfg(K), batched);
  let segs = (await bucket.list("mh/spaces/default/oplog/nodeAAAA/")).filter((o) =>
    o.key.endsWith(".seg"),
  );
  expect(segs.length).toBe(0); // deferred — no tiny segment written

  await syncWithStorage(a, PEER, bucket, cfg(K), { ...batched, forcePush: true });
  segs = (await bucket.list("mh/spaces/default/oplog/nodeAAAA/")).filter((o) =>
    o.key.endsWith(".seg"),
  );
  expect(segs.length).toBe(1); // force flushed

  // And a peer still converges after the forced flush.
  const b = makeNode("nodeBBBB");
  await syncWithStorage(b, PEER, bucket, cfg(K));
  expect(headState(b)).toEqual(headState(a));
});

// ---- request-shape regressions (①, ⑤) -------------------------------------------

/** FakeBucket that records get/list calls so tests can assert request shape. */
class CountingBucket extends FakeBucket {
  gets: string[] = [];
  lists: string[] = [];
  async get(key: string): Promise<Uint8Array | null> {
    this.gets.push(key);
    return super.get(key);
  }
  async list(prefix: string, startAfter?: string, delimiter?: string): Promise<StorageObject[]> {
    this.lists.push(prefix);
    return super.list(prefix, startAfter, delimiter);
  }
  snapBodyGets(): number {
    return this.gets.filter((k) => k.endsWith(".snap")).length;
  }
}

test("① push-only round (pull:false) skips the PULL LISTs but still pushes a segment", async () => {
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA");
  const bucket = new CountingBucket();
  createDatabase(a, { name: "X" });
  bucket.lists.length = 0;
  await syncWithStorage(a, PEER, bucket, cfg(K), { pull: false });
  // No snapshot/ or oplog/-root (node discovery) LIST — those are the PULL cost.
  expect(bucket.lists.some((p) => p.endsWith("/snapshot/"))).toBe(false);
  expect(bucket.lists.some((p) => p.endsWith("/oplog/"))).toBe(false);
  // The own segment was still pushed (Path B durability).
  const segs = (await bucket.list("mh/spaces/default/oplog/nodeAAAA/")).filter((o) =>
    o.key.endsWith(".seg"),
  );
  expect(segs.length).toBe(1);
});

test("Path B: an edit reaches a fresh node via the author's own segment, no snapshot", async () => {
  const K = generateMasterKey();
  const b = makeNode("nodeBBBB");
  const c = makeNode("nodeCCCC");
  const bucket = new FakeBucket();
  createDatabase(b, { name: "OnlyInSegment" });
  await syncWithStorage(b, PEER, bucket, cfg(K)); // segment only (no publish)
  expect((await bucket.list("mh/spaces/default/snapshot/")).length).toBe(0); // no snapshot
  await syncWithStorage(c, PEER, bucket, cfg(K)); // hydrate purely from B's segment
  expect(headState(c)).toEqual(headState(b));
});

test("⑤b: a caught-up consumer skips the whole-hub snapshot body (reads only .vc)", async () => {
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA");
  const b = makeNode("nodeBBBB");
  const bucket = new CountingBucket();

  // A pushes its state as a SEGMENT; B catches up incrementally (no snapshot yet).
  createDatabase(a, { name: "Notes" });
  await syncWithStorage(a, PEER, bucket, cfg(K));
  await syncWithStorage(b, PEER, bucket, cfg(K));
  expect(headState(b)).toEqual(headState(a));

  // A (publisher) now publishes a whole-hub snapshot of the state B already holds.
  await publishSnapshot(a, bucket, cfg(K));

  bucket.gets.length = 0;
  await syncWithStorage(b, PEER, bucket, cfg(K));
  expect(bucket.snapBodyGets()).toBe(0); // dominated → skipped the whole-hub body
  expect(bucket.gets.some((k) => k.endsWith(".vc"))).toBe(true); // but read the frontier
  expect(headState(b)).toEqual(headState(a)); // still converged
});

test("⑤b: a behind consumer still downloads the snapshot (no data loss)", async () => {
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA");
  const c = makeNode("nodeCCCC");
  const bucket = new CountingBucket();
  createDatabase(a, { name: "Notes" });
  await syncWithStorage(a, PEER, bucket, cfg(K));
  await publishSnapshot(a, bucket, cfg(K), 0); // snapshot + full truncate (segments gone)
  bucket.gets.length = 0;
  await syncWithStorage(c, PEER, bucket, cfg(K)); // empty → can't dominate → downloads body
  expect(bucket.snapBodyGets()).toBeGreaterThanOrEqual(1);
  expect(headState(c)).toEqual(headState(a));
});

test("⑤ incremental: a connected consumer stays on segments across publisher snapshots", async () => {
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA");
  const b = makeNode("nodeBBBB");
  const bucket = new CountingBucket();

  // Realistic timing: A pushes a segment, B pulls it, THEN A publishes a snapshot —
  // so B already dominates each snapshot by the time it appears.
  for (let i = 0; i < 5; i++) {
    createDatabase(a, { name: `db${i}` });
    await syncWithStorage(a, PEER, bucket, cfg(K)); // push seg_i
    await syncWithStorage(b, PEER, bucket, cfg(K)); // B pulls seg_i (incremental)
    await publishSnapshot(a, bucket, cfg(K)); // publish snap_i (B already has it)
  }

  bucket.gets.length = 0;
  await syncWithStorage(b, PEER, bucket, cfg(K));
  expect(bucket.snapBodyGets()).toBe(0); // never re-downloads a whole-hub snapshot
  expect(headState(b)).toEqual(headState(a));
});

test("⑤c: publishSnapshot retains recent own segments (default window), bucket bounded", async () => {
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA");
  const bucket = new FakeBucket();
  // Three separate push rounds → three own segments.
  for (let i = 0; i < 3; i++) {
    createDatabase(a, { name: `db${i}` });
    await syncWithStorage(a, PEER, bucket, cfg(K));
  }
  const before = (await bucket.list("mh/spaces/default/oplog/nodeAAAA/")).filter((o) =>
    o.key.endsWith(".seg"),
  ).length;
  await publishSnapshot(a, bucket, cfg(K)); // default retain ≫ 3 → keep them all
  const after = (await bucket.list("mh/spaces/default/oplog/nodeAAAA/")).filter((o) =>
    o.key.endsWith(".seg"),
  ).length;
  expect(after).toBe(before); // recent segments retained, not collapsed to 0
  // …and a snapshot exists alongside them with its frontier sidecar.
  const snaps = await bucket.list("mh/spaces/default/snapshot/");
  expect(snaps.some((o) => o.key.endsWith(".snap"))).toBe(true);
  expect(snaps.some((o) => o.key.endsWith(".vc"))).toBe(true);
});

test("④: the elected publisher reaps leases expired past the grace window", async () => {
  const bucket = new FakeBucket();
  const base = "mh-lease-gc/spaces/default";
  const enc = (o: object) => new TextEncoder().encode(JSON.stringify(o));
  const TTL = 5 * 60_000;
  // A long-dead candidate (expired by > a full TTL) lingers in the bucket.
  await bucket.put(
    `${base}/publisher/deadXXXX.lease`,
    enc({ node: "deadXXXX", priority: 100, expiresAt: Date.now() - 2 * TTL }),
  );
  const elected = await isElectedPublisher(bucket, base, "nodeLIVE", 10);
  expect(elected).toBe(true); // only live candidate → we win
  const leases = (await bucket.list(`${base}/publisher/`)).filter((o) => o.key.endsWith(".lease"));
  expect(leases.some((o) => o.key.includes("deadXXXX"))).toBe(false); // reaped
  expect(leases.some((o) => o.key.includes("nodeLIVE"))).toBe(true); // our fresh heartbeat
});
