import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "./schema-init.ts";
import { emit, changesAfterSeq, ingest } from "./crdt.ts";
import {
  readPolicy,
  setFullNodes,
  setRedundancy,
  isFullBlobNode,
  announcePresence,
  holders,
  isClearable,
  referencedHashes,
  recordBlob,
  cacheStats,
  knownNodes,
} from "./blobs-core.ts";

function makeNode(id: string): Database {
  const db = new Database(":memory:");
  initSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return db;
}

/** Replicate every change from `from` into `to` (one-way full sync). */
function syncAll(from: Database, to: Database): void {
  const { changes } = changesAfterSeq(from, 0);
  ingest(to, changes);
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

test("no anchor → nothing clearable", () => {
  const db = makeNode("n1");
  recordBlob(db, H1, 100, "image/png");
  expect(isClearable(db, H1)).toBe(false); // fullNodes empty
});

test("a full node never clears its own blobs", () => {
  const db = makeNode("full");
  setFullNodes(db, ["full"]);
  recordBlob(db, H1, 100, "image/png");
  announcePresence(db, H1, 100);
  expect(isFullBlobNode(db)).toBe(true);
  expect(isClearable(db, H1)).toBe(false);
});

test("consumer may clear once the single full node holds it", () => {
  const full = makeNode("full");
  const phone = makeNode("phone");
  setFullNodes(full, ["full"]);
  recordBlob(full, H1, 100, "image/png");
  announcePresence(full, H1, 100);

  syncAll(full, phone); // policy + presence replicate

  expect(readPolicy(phone).fullNodes).toEqual(["full"]);
  expect(holders(phone, H1)).toEqual(["full"]);
  recordBlob(phone, H1, 100, "image/png"); // phone downloaded it
  expect(isClearable(phone, H1)).toBe(true); // re-fetchable from full → safe
  expect(isClearable(phone, H2)).toBe(false); // full doesn't hold H2
});

test("redundancy all vs any with two full nodes", () => {
  const a = makeNode("A");
  const b = makeNode("B");
  const phone = makeNode("phone");
  setFullNodes(a, ["A", "B"]);
  announcePresence(a, H1, 100); // only A holds H1
  syncAll(a, phone);
  syncAll(b, phone); // B holds nothing

  // all: needs both A and B → not clearable yet
  expect(isClearable(phone, H1)).toBe(false);

  // any: A holding it is enough
  setRedundancy(a, "any");
  syncAll(a, phone);
  expect(isClearable(phone, H1)).toBe(true);
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

test("cacheStats splits clearable vs retained bytes", () => {
  const full = makeNode("full");
  const phone = makeNode("phone");
  setFullNodes(full, ["full"]);
  announcePresence(full, H1, 1000); // full holds H1 only
  syncAll(full, phone);

  recordBlob(phone, H1, 1000, "image/png"); // clearable
  recordBlob(phone, H2, 500, "image/png"); // sole copy → retained

  const s = cacheStats(phone);
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
