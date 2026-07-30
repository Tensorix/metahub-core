// Real-bucket integration test for storage-sync. Skipped unless the
// METAHUB_TEST_S3_* env vars point at a bucket (Cloudflare R2, MinIO, or S3):
//
//   METAHUB_TEST_S3_ENDPOINT=https://<acct>.r2.cloudflarestorage.com \
//   METAHUB_TEST_S3_BUCKET=my-metahub \
//   METAHUB_TEST_S3_ACCESS_KEY=... METAHUB_TEST_S3_SECRET_KEY=... \
//   [METAHUB_TEST_S3_REGION=auto] bun test storage-s3.integration
//
// Local MinIO quickstart:
//   docker run -p 9000:9000 -e MINIO_ROOT_USER=minioadmin \
//     -e MINIO_ROOT_PASSWORD=minioadmin quay.io/minio/minio server /data
//   (create a bucket, then point ENDPOINT=http://localhost:9000 with those creds)
//
// It exercises the real Bun.S3Client wire path (list/get/put/del + ListObjectsV2
// pagination/XML, delimiter common-prefixes, conditional provisioning) that the
// in-memory FakeBucket can't — the one gap the unit suite leaves open.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { emit, emitFields } from "../crdt.ts";
import { createDatabase } from "../databases.ts";
import { generateMasterKey, toB64 } from "./e2ee.ts";
import { syncWithStorage, storageClientFor, provisionMasterKey, type S3Config } from "./storage.ts";
import "./storage-s3-bun.ts"; // registers the Bun.S3Client factory (side effect)
import { putBucketCors } from "./storage-s3-bun.ts";
import { getBucketCors } from "./storage-s3-sign.ts";

const E = process.env;
const HAVE_BUCKET =
  !!E.METAHUB_TEST_S3_ENDPOINT &&
  !!E.METAHUB_TEST_S3_BUCKET &&
  !!E.METAHUB_TEST_S3_ACCESS_KEY &&
  !!E.METAHUB_TEST_S3_SECRET_KEY;

const it = HAVE_BUCKET ? test : test.skip;
const PEER = "s3://integration-test";

function baseCfg(prefix: string): Omit<S3Config, "masterKey"> {
  return {
    endpoint: E.METAHUB_TEST_S3_ENDPOINT!,
    region: E.METAHUB_TEST_S3_REGION || "auto",
    bucket: E.METAHUB_TEST_S3_BUCKET!,
    prefix,
    accessKeyId: E.METAHUB_TEST_S3_ACCESS_KEY!,
    secretAccessKey: E.METAHUB_TEST_S3_SECRET_KEY!,
    encrypt: true,
  };
}

function makeNode(id: string): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  db.query("INSERT INTO peers (url, kind, enabled) VALUES (?, 's3', 1)").run(PEER);
  return db;
}

/** Unique prefix per run so concurrent CI / leftover objects never collide. */
function runPrefix(): string {
  return `mh-it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

it("round-trips and converges across two nodes through a real bucket", async () => {
  const cfg: S3Config = { ...baseCfg(runPrefix()), masterKey: toB64(generateMasterKey()) };
  const a = makeNode("itnodeAA");
  const b = makeNode("itnodeBB");
  const cleanup = storageClientFor(cfg);
  try {
    // A writes offline, pushes to the bucket.
    const dbId = createDatabase(a, { name: "Integration" }).id;
    emitFields(a, "records", "rec-1", { database_id: dbId, title: "hello" });
    const r1 = await syncWithStorage(a, PEER, storageClientFor(cfg), cfg);
    expect(r1.pushed).toBeGreaterThan(0);

    // B (separate node) pulls A's segment.
    await syncWithStorage(b, PEER, storageClientFor(cfg), cfg);
    const recB = b.query("SELECT data FROM records WHERE id = 'rec-1'").get() as { data: string } | null;
    expect(recB).not.toBeNull();
    expect(JSON.parse(recB!.data).title).toBe("hello");

    // B edits, pushes; A pulls → converges byte-for-byte.
    emit(b, "records", "rec-1", "title", "hi there");
    await syncWithStorage(b, PEER, storageClientFor(cfg), cfg);
    await syncWithStorage(a, PEER, storageClientFor(cfg), cfg);
    const recA = a.query("SELECT data FROM records WHERE id = 'rec-1'").get() as { data: string };
    expect(JSON.parse(recA.data).title).toBe("hi there");
  } finally {
    for (const o of await cleanup.list(`${cfg.prefix}/`)) await cleanup.del(o.key);
  }
});

it("putBucketCors sets/merges/reads the managed CORS rule (Content-MD5 + XML)", async () => {
  // Bucket-level state (not prefix-scoped): this rewrites the bucket's CORS. We
  // leave it open ("*") at the end so the browser e2e flow keeps working.
  const cfg = baseCfg(runPrefix()) as S3Config;
  const O1 = "https://shell-test-1.example";
  const O2 = "https://shell-test-2.example";

  await putBucketCors(cfg, [O1]);
  let xml = await getBucketCors(cfg);
  expect(xml).not.toBeNull();
  expect(xml!).toContain("<ID>metahub-pwa</ID>");
  expect(xml!).toContain(O1);
  // The methods a browser shell needs.
  for (const m of ["GET", "PUT", "HEAD", "DELETE"]) expect(xml!).toContain(`<AllowedMethod>${m}</AllowedMethod>`);

  // Re-run with a different origin → managed rule is replaced, not duplicated.
  await putBucketCors(cfg, [O2]);
  xml = await getBucketCors(cfg);
  expect(xml!).toContain(O2);
  expect(xml!).not.toContain(O1);
  expect((xml!.match(/<ID>metahub-pwa<\/ID>/g) ?? []).length).toBe(1);

  // Restore open CORS for the rest of the manual/browser testing.
  await putBucketCors(cfg, ["*"]);
});

it("provisionMasterKey creates then adopts the bucket's wrapped key", async () => {
  const cfg = baseCfg(runPrefix());
  const client = storageClientFor(cfg as S3Config);
  try {
    const k1 = await provisionMasterKey(client, cfg as S3Config, "correct horse battery staple");
    const k2 = await provisionMasterKey(client, cfg as S3Config, "correct horse battery staple");
    expect(k1).not.toBeNull();
    expect(k2).toBe(k1); // second device reads & unwraps the same key

    // Wrong passphrase is rejected (GCM tag fails to verify).
    await expect(provisionMasterKey(client, cfg as S3Config, "wrong")).rejects.toThrow();
  } finally {
    for (const o of await client.list(`${cfg.prefix}/`)) await client.del(o.key);
  }
});
