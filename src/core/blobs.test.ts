import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "./schema-init.ts";
import { emit } from "./crdt.ts";
import {
  readPolicy,
  setFullNodes,
  setRedundancy,
  isFullBlobNode,
  isClearable,
  setPending,
  referencedHashes,
  recordBlob,
  cacheStats,
  knownNodes,
} from "./blobs-core.ts";
import { knownBuckets } from "./blobs.ts";
import { addStoragePeer } from "./sync/peers.ts";
import type { S3Config } from "./sync/storage.ts";

function s3Config(bucket = "bucket"): S3Config {
  return {
    endpoint: "https://example.com",
    region: "auto",
    bucket,
    prefix: "metahub",
    accessKeyId: "id",
    secretAccessKey: "secret",
    encrypt: false,
  };
}

function makeNode(id: string): Database {
  const db = new Database(":memory:");
  initSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return db;
}

const H1 = "a".repeat(32); // canonical 32-hex hashes
const H2 = "b".repeat(32);

test("policy defaults to no full nodes / all redundancy", () => {
  const db = makeNode("n1");
  const p = readPolicy(db);
  expect(p.fullNodes).toEqual([]);
  expect(p.redundancy).toBe("all");
  expect(isFullBlobNode(db)).toBe(false);
});

test("setFullNodes / setRedundancy persist and de-dupe", () => {
  const db = makeNode("n1");
  setFullNodes(db, ["nA", "nB", "nA"]);
  setRedundancy(db, "any");
  const p = readPolicy(db);
  expect(p.fullNodes).toEqual(["nA", "nB"]);
  expect(p.redundancy).toBe("any");
});

test("a produced-but-unflushed blob (pending) is NOT clearable; flushing makes it clearable", () => {
  const db = makeNode("n1");
  setFullNodes(db, ["anchorX"]); // a designated durable anchor exists (the safety floor)
  recordBlob(db, H1, 100, "image/png"); // produced here → pending=1, protected
  expect(isClearable(db, H1)).toBe(false);
  setPending(db, H1, false); // confirmed flushed to the anchor
  expect(isClearable(db, H1)).toBe(true);
});

test("an acquired cache blob (pending=0) is clearable", () => {
  const db = makeNode("n1");
  setFullNodes(db, ["anchorX"]); // designated anchor → cache is re-fetchable
  recordBlob(db, H1, 100, "image/png", 0); // acquired → already durable at its source
  expect(isClearable(db, H1)).toBe(true);
});

test("with NO durable anchor designated, nothing is clearable (safety floor)", () => {
  const db = makeNode("n1");
  recordBlob(db, H1, 100, "image/png", 0); // acquired, pending=0 — but no anchor exists
  expect(readPolicy(db).fullNodes).toEqual([]);
  expect(isClearable(db, H1)).toBe(false); // no guaranteed holder → never drop the last copy
});

test("a full blob device never clears anything", () => {
  const db = makeNode("full");
  setFullNodes(db, ["full"]);
  recordBlob(db, H1, 100, "image/png", 0); // even a non-pending blob
  expect(isFullBlobNode(db)).toBe(true);
  expect(isClearable(db, H1)).toBe(false);
});

test("clear decision is purely local/offline — no sync needed", () => {
  // phone never syncs anything; clearability comes from the local pending flag plus
  // the locally-stored policy (a designated anchor) — both offline, no sync.
  const phone = makeNode("phone");
  setFullNodes(phone, ["cloud"]); // designate a durable anchor (local policy)
  recordBlob(phone, H1, 100, "image/png", 0); // acquired → clearable
  recordBlob(phone, H2, 100, "image/png"); // produced, unflushed → protected
  expect(isClearable(phone, H1)).toBe(true);
  expect(isClearable(phone, H2)).toBe(false);
});

test("referencedHashes unions site_files blobs and doc image markdown", () => {
  const db = makeNode("n1");
  // a site file stored as a blob
  emit(db, "site_files", "sf1", "encoding", "blob");
  emit(db, "site_files", "sf1", "content", H1);
  emit(db, "site_files", "sf1", "__deleted", 0);
  // a document image reference
  emit(db, "doc_blocks", "b1", "text", `![diagram](/blob/${H2}.png)`);
  emit(db, "doc_blocks", "b1", "__deleted", 0);

  const refs = referencedHashes(db);
  expect(refs.has(H1)).toBe(true);
  expect(refs.has(H2)).toBe(true);
  expect(refs.size).toBe(2);

  // deleting the block drops its reference
  emit(db, "doc_blocks", "b1", "__deleted", 1);
  expect(referencedHashes(db).has(H2)).toBe(false);
});

test("cacheStats: pending bytes retained, non-pending bytes clearable", () => {
  const db = makeNode("n1");
  setFullNodes(db, ["anchorX"]); // a designated anchor exists (else nothing is clearable)
  recordBlob(db, H1, 1000, "image/png", 0); // acquired → clearable
  recordBlob(db, H2, 500, "image/png"); // produced unflushed → retained
  const s = cacheStats(db);
  expect(s.totalBytes).toBe(1500);
  expect(s.clearableBytes).toBe(1000);
  expect(s.retainedBytes).toBe(500);
  expect(s.count).toBe(2);
  expect(s.clearableCount).toBe(1);
});

test("knownNodes always includes self", () => {
  const db = makeNode("self1");
  const nodes = knownNodes(db);
  const self = nodes.find((n) => n.self);
  expect(self?.nodeId).toBe("self1");
});

test("knownBuckets lists attached s3 peers (empty without)", () => {
  const db = makeNode("n1");
  expect(knownBuckets(db)).toEqual([]);
  addStoragePeer(db, { url: "s3://bucket/metahub", config: s3Config("mybucket"), label: "Home" });
  const bs = knownBuckets(db);
  expect(bs).toHaveLength(1);
  expect(bs[0]).toMatchObject({ url: "s3://bucket/metahub", label: "Home", bucket: "mybucket" });
  // s3 peer never pollutes the node roster
  expect(knownNodes(db).some((n) => n.nodeId === "s3://bucket/metahub")).toBe(false);
});

test("bucket url is a valid full-blob anchor without affecting node judgments", () => {
  const db = makeNode("self1");
  setFullNodes(db, ["s3://bucket/metahub"]);
  expect(readPolicy(db).fullNodes).toEqual(["s3://bucket/metahub"]);
  // self is not a node anchor, so it still clears flushed blobs as before
  expect(isFullBlobNode(db)).toBe(false);
  recordBlob(db, H1, 1000, "image/png", 0); // acquired → clearable
  expect(isClearable(db, H1)).toBe(true);
});
