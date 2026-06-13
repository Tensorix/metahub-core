import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { emit, emitFields } from "../crdt.ts";
import { createDatabase } from "../databases.ts";
import { createDocument, getDocument, updateDocument } from "../documents.ts";
import { generateMasterKey, toB64 } from "./e2ee.ts";
import {
  syncWithStorage,
  publishSnapshot,
  type S3Config,
  type StorageClient,
  type StorageObject,
} from "./storage.ts";

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
  async list(prefix: string, startAfter?: string): Promise<StorageObject[]> {
    return [...this.store.keys()]
      .filter((k) => k.startsWith(prefix) && (startAfter == null || k > startAfter))
      .sort()
      .map((key) => ({ key }));
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, body: Uint8Array): Promise<void> {
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

  // Publish a snapshot and truncate A's segments.
  const snap = await publishSnapshot(a, bucket, cfg(K));
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

test("snapshotEverySegments threshold triggers auto snapshot + truncation", async () => {
  const K = generateMasterKey();
  const a = makeNode("nodeAAAA");
  const bucket = new FakeBucket();
  const config = cfg(K);

  // Each sync round with new ops writes one segment; threshold 2 collapses them.
  createDatabase(a, { name: "1" });
  await syncWithStorage(a, PEER, bucket, config, { snapshotEverySegments: 2 });
  createDatabase(a, { name: "2" });
  await syncWithStorage(a, PEER, bucket, config, { snapshotEverySegments: 2 });

  const snaps = (await bucket.list("mh/spaces/default/snapshot/")).filter((o) =>
    o.key.endsWith(".snap"),
  );
  expect(snaps.length).toBeGreaterThanOrEqual(1);
  const segs = (await bucket.list("mh/spaces/default/oplog/nodeAAAA/")).filter((o) =>
    o.key.endsWith(".seg"),
  );
  expect(segs.length).toBe(0); // collapsed into the snapshot
});
