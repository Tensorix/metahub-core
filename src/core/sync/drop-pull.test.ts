// End-to-end pull tests against the REAL edge worker handler (in-memory D1
// stand-in): SDK-sealed envelopes → POST → pullDropsOnce → decrypt/validate/
// ingest → ack. Covers the idempotent-replay ("re-pull → inserted:0 → catch-up
// ack"), the two ack-gate states (bucket push cursor), invalid-envelope
// rejection (drop_rejects + immediate delete) and two-replica convergence.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { createDatabase } from "../databases.ts";
import { addProperty } from "../properties.ts";
import { listRecords } from "../records.ts";
import { changesSince, emit, ingest } from "../crdt.ts";
import { createSite, setSitePublicGrants, type SiteRow } from "../sites-core.ts";
import { toB64, fromB64, encryptBytes, generateMasterKey } from "./e2ee.ts";
import { createInboxFetch, type EdgeSql } from "../../workers/edge-worker.ts";
import { memSql } from "../../workers/edge-worker.test-util.ts";
import { httpDropHost, type DropHostApi } from "./drop-host.ts";
import { setEdgeConfig } from "./edge-config.ts";
import {
  ensureDropKeys,
  activeDropKey,
  getLocalDropKeyring,
  saveLocalDropKeyring,
} from "./drop-keys.ts";
import { pullDropsOnce, dropWiredSites, changesMaxSeq } from "./drop-pull.ts";
import { createDrop, type DropClient, type DropStorage } from "../../sdk/drop.ts";

const OWNER = "drt_pulltest";
const ENDPOINT = "http://edge.test";

function memStorage(): DropStorage {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v) };
}

interface Rig {
  db: Database;
  site: SiteRow;
  dbId: string;
  titleProp: string;
  host: DropHostApi;
  sql: EdgeSql;
  drop: DropClient; // SDK client wired straight into the worker handler
}

async function rig(node = "hostnode"): Promise<Rig> {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(node);
  const table = createDatabase(db, { name: "guestbook" });
  const title = addProperty(db, table.id, { name: "Title", type: "text" });
  const site = createSite(db, { name: "demo", visibility: "public" });
  const granted = setSitePublicGrants(db, site.id, { v: 1, tables: [{ db: table.id, ops: ["create"] }] });

  setEdgeConfig(db, { endpoint: ENDPOINT, token: OWNER });
  const sql = memSql();
  const handler = createInboxFetch({ sql, ownerToken: OWNER });
  const fetcher = ((input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof fetch;
  const host = httpDropHost(ENDPOINT, OWNER, fetcher);
  await host.register(site.id, {});

  const keyring = await ensureDropKeys(db, { bucket: null });
  const key = activeDropKey(keyring);
  const drop = createDrop(
    {
      v: 1,
      endpoint: ENDPOINT,
      drop_id: site.id,
      key_id: key.key_id,
      pk: key.pk,
      databases: [
        { id: table.id, name: "guestbook", properties: [{ id: title.id, name: "Title", type: "text" }] },
      ],
    },
    { fetcher, storage: memStorage() },
  );
  return { db, site: granted, dbId: table.id, titleProp: title.id, host, sql, drop, key };
}

function addBucketPeer(db: Database, url = "s3://host/bucket/metahub"): string {
  const config = {
    endpoint: "https://bucket.example",
    region: "auto",
    bucket: "bucket",
    prefix: "metahub",
    accessKeyId: "a",
    secretAccessKey: "s",
    encrypt: true,
    masterKey: toB64(generateMasterKey()),
  };
  db.query(
    "INSERT INTO peers (url, kind, config, enabled, pull_cursor, push_cursor) VALUES (?, 's3', ?, 1, 0, 0)",
  ).run(url, JSON.stringify(config));
  return url;
}

test("dropWiredSites: exactly the sites with a create grant", async () => {
  const r = await rig();
  expect(dropWiredSites(r.db).map((s) => s.id)).toEqual([r.site.id]);
  setSitePublicGrants(r.db, r.site.id, { v: 1, tables: [{ db: r.dbId, ops: ["read"] }] });
  expect(dropWiredSites(r.db)).toHaveLength(0);
});

test("happy path (no bucket): submit → pull → guest record lands, envelope acked", async () => {
  const r = await rig();
  const pendingRec = await r.drop.createRecord("guestbook", { Title: "hello from a visitor" });
  expect(pendingRec._pending).toBe(true);

  const s = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s.skipped).toBeUndefined();
  expect(s.fetched).toBe(1);
  expect(s.ingested).toBeGreaterThan(0);
  expect(s.acked).toBe(1);
  expect(s.rejected).toBe(0);

  const rows = listRecords(r.db, r.dbId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.id).toBe(pendingRec.id);
  expect(rows[0]!.values["Title"]).toBe("hello from a visitor");
  // attribution: every op signed by the visitor's guest node, txn drop:<id>
  const op = r.db
    .query("SELECT node_id, txn FROM crdt_changes WHERE dataset = 'records' AND row_id = ?")
    .get(pendingRec.id) as { node_id: string; txn: string };
  expect(op.node_id).toBe(r.drop.guest);
  expect(op.txn).toBe("drop:" + pendingRec.envelope_id);
  // inbox drained
  expect(await r.host.listEnvelopes(r.site.id, 0, 100)).toHaveLength(0);
});

/** A v2 (GuestIntent) drop client over the same rig — payload_versions:[2]. */
function v2Drop(r: Rig) {
  const handler = createInboxFetch({ sql: r.sql, ownerToken: OWNER });
  const fetcher = ((input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof fetch;
  return createDrop(
    {
      v: 1,
      endpoint: ENDPOINT,
      drop_id: r.site.id,
      key_id: r.key.key_id,
      pk: r.key.pk,
      payload_versions: [2],
      databases: [{ id: r.dbId, name: "guestbook", properties: [{ id: r.titleProp, name: "Title", type: "text" }] }],
    },
    { fetcher, storage: memStorage() },
  );
}

test("v2 drop: SDK seals a GuestIntent; owner mints the op on the guest timeline (no browser HLC), acked", async () => {
  const r = await rig();
  const drop = v2Drop(r);
  const before = Date.now();
  const pending = await drop.createRecord("guestbook", { Title: "v2 hello" });
  expect(pending._pending).toBe(true);

  const s = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s.v2).toBe(1);
  expect(s.v1).toBe(0);
  expect(s.acked).toBe(1);
  expect(s.ingested).toBeGreaterThan(0);

  const rows = listRecords(r.db, r.dbId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.id).toBe(pending.id); // client-minted rowId honored
  expect(rows[0]!.values["Title"]).toBe("v2 hello");
  // The op is stamped with the guest-scoped intent txn (not drop:<envId>) and
  // authored by the guest node; its HLC millis is server-minted near submit time.
  const op = r.db
    .query("SELECT node_id, txn, hlc FROM crdt_changes WHERE dataset='records' AND row_id=? AND col=?")
    .get(pending.id, r.titleProp) as { node_id: string; txn: string; hlc: string };
  expect(op.node_id).toBe(drop.guest);
  expect(op.txn).toStartWith("intent:");
  expect(Number(op.hlc.slice(0, 15))).toBeGreaterThanOrEqual(before);
  expect(await r.host.listEnvelopes(r.site.id, 0, 100)).toHaveLength(0);
});

test("v2 drop: create-only intent cannot overwrite an existing row id", async () => {
  const r = await rig();
  const pending = await v2Drop(r).createRecord("guestbook", { Title: "guest" });
  emit(r.db, "records", pending.id, "database_id", r.dbId);
  emit(r.db, "records", pending.id, r.titleProp, "owner");

  const s = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s.rejected).toBe(1);
  expect(s.ingested).toBe(0);
  const rows = listRecords(r.db, r.dbId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.values["Title"]).toBe("owner");
});

test("v2 drop: create-only intent cannot resurrect a tombstoned row id", async () => {
  const r = await rig();
  const pending = await v2Drop(r).createRecord("guestbook", { Title: "guest" });
  emit(r.db, "records", pending.id, "database_id", r.dbId);
  emit(r.db, "records", pending.id, r.titleProp, "owner");
  emit(r.db, "records", pending.id, "__deleted", 1);

  const s = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s.rejected).toBe(1);
  expect(s.ingested).toBe(0);
  expect(listRecords(r.db, r.dbId)).toHaveLength(0);
  expect(
    r.db.query("SELECT COUNT(*) AS n FROM crdt_changes WHERE txn LIKE 'intent:%'").get(),
  ).toEqual({ n: 0 });
});

test("v2 drop: replaying the SAME intent under a new envelope_id is idempotent (no duplicate), still acks", async () => {
  const r = await rig();
  const drop = v2Drop(r);
  await drop.createRecord("guestbook", { Title: "once" });
  // Capture the sealed envelope, then re-submit it under a fresh envelope_id.
  const original = (await r.host.listEnvelopes(r.site.id, 0, 100))[0]!.envelope as Record<string, unknown>;

  const s1 = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s1.acked).toBe(1);
  expect(listRecords(r.db, r.dbId)).toHaveLength(1);

  const replay = JSON.stringify({ ...original, envelope_id: original.envelope_id + "-r" });
  await createInboxFetch({ sql: r.sql, ownerToken: OWNER })(
    new Request(`${ENDPOINT}/v1/inbox/${r.site.id}/envelopes`, { method: "POST", body: replay }),
  );
  const s2 = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s2.v2).toBe(1);
  expect(s2.acked).toBe(1); // acked+deleted, not deferred forever
  expect(s2.deferred).toBe(0);
  expect(listRecords(r.db, r.dbId)).toHaveLength(1); // still exactly one — idempotent on intentId
});

test("ack gate: with a bucket, deferred until push_cursor covers the ingest; replay is inserted:0 + catch-up ack", async () => {
  const r = await rig();
  const url = addBucketPeer(r.db);
  await r.drop.createRecord("guestbook", { Title: "gated" });

  // Round 1: cursor at 0 → ingested but NOT acked (deferred).
  const s1 = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s1.ingested).toBeGreaterThan(0);
  expect(s1.acked).toBe(0);
  expect(s1.deferred).toBe(1);
  expect(await r.host.listEnvelopes(r.site.id, 0, 100)).toHaveLength(1);
  expect(listRecords(r.db, r.dbId)).toHaveLength(1);

  // Round 2 before the bucket caught up: replay ingests nothing, still deferred.
  const s2 = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s2.ingested).toBe(0);
  expect(s2.deferred).toBe(1);
  expect(listRecords(r.db, r.dbId)).toHaveLength(1); // no duplicates ever

  // Bucket round advances the push cursor → round 3 acks (inserted:0 → 补 ack).
  const max = (r.db.query("SELECT MAX(seq) AS s FROM crdt_changes").get() as { s: number }).s;
  r.db.query("UPDATE peers SET push_cursor = ? WHERE url = ?").run(max, url);
  const s3 = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s3.ingested).toBe(0);
  expect(s3.acked).toBe(1);
  expect(s3.deferred).toBe(0);
  expect(await r.host.listEnvelopes(r.site.id, 0, 100)).toHaveLength(0);
});

test("invalid envelopes: recorded in drop_rejects, deleted from the host, never in the oplog", async () => {
  const r = await rig();
  // a submission against an UNGRANTED table (schema lied to the page)
  const evil = createDrop(
    {
      ...r.drop.config,
      databases: [
        {
          id: "db_ungranted-x1",
          name: "secrets",
          properties: [{ id: "prop_x", name: "Title", type: "text" }],
        },
      ],
    },
    {
      fetcher: ((input: string | URL | Request, init?: RequestInit) =>
        httpFetch(r, input, init)) as typeof fetch,
      storage: memStorage(),
    },
  );
  function httpFetch(rr: Rig, input: string | URL | Request, init?: RequestInit): Promise<Response> {
    return createInboxFetch({ sql: rr.sql, ownerToken: OWNER })(new Request(input, init));
  }
  await evil.createRecord("secrets", { Title: "let me in" });

  const s = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s.rejected).toBe(1);
  expect(s.ingested).toBe(0);
  expect(listRecords(r.db, r.dbId)).toHaveLength(0);
  const rejects = r.db.query("SELECT drop_id, reason FROM drop_rejects").all() as {
    drop_id: string;
    reason: string;
  }[];
  expect(rejects).toHaveLength(1);
  expect(rejects[0]!.drop_id).toBe(r.site.id);
  // invalid mail is deleted immediately — it must not occupy inbox capacity
  expect(await r.host.listEnvelopes(r.site.id, 0, 100)).toHaveLength(0);
});

test("unknown key_id is rejected, not crashed on", async () => {
  const r = await rig();
  const rogue = createDrop(
    { ...r.drop.config, key_id: "knowhere1" },
    {
      fetcher: ((input: string | URL | Request, init?: RequestInit) =>
        createInboxFetch({ sql: r.sql, ownerToken: OWNER })(new Request(input, init))) as typeof fetch,
      storage: memStorage(),
    },
  );
  await rogue.createRecord("guestbook", { Title: "sealed to nobody" });
  const s = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s.rejected).toBe(1);
  expect(listRecords(r.db, r.dbId)).toHaveLength(0);
});

test("held (not deleted) when OUR drop key can't be unwrapped — a local bucket-key fault (F5)", async () => {
  const r = await rig();
  await r.drop.createRecord("guestbook", { Title: "sealed to a valid key" });

  // Simulate a LOCAL fault: the keyring's private half is wrapped with one key,
  // but the attached bucket now carries a DIFFERENT master key (misconfig / bad
  // rotation) → dropKeySecret throws auth for EVERY envelope. That is our fault,
  // not the mail's — it must be HELD, never acked+deleted.
  const kr = getLocalDropKeyring(r.db)!;
  const rec = kr.keys[0]!;
  const wrongMaster = generateMasterKey();
  const wrapped = { ...rec, sk: toB64(await encryptBytes(wrongMaster, fromB64(rec.sk))), wrapped: true };
  saveLocalDropKeyring(r.db, { v: 1, keys: [wrapped] });
  addBucketPeer(r.db); // bucket master key is yet another (also non-matching) key

  const s = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s.held).toBe(1);
  expect(s.acked).toBe(0);
  expect(s.rejected).toBe(0);
  expect(s.ingested).toBe(0);
  // legit mail is STILL on the host, awaiting a fixed pull — nothing lost
  expect(await r.host.listEnvelopes(r.site.id, 0, 100)).toHaveLength(1);
  expect(listRecords(r.db, r.dbId)).toHaveLength(0);
});

test("bucket key fault short-circuits the round: one failed unwrap stops downloads for every drop", async () => {
  // The bucket master key + keyring are round-shared, so a dropKeySecret fault
  // is identical for every envelope of every drop. Re-attempting per envelope
  // (and re-listing per drop) would re-pay download + AES-GCM for the whole
  // held backlog every round, forever, while the key stays misconfigured.
  const r = await rig();
  const table2 = createDatabase(r.db, { name: "guestbook2" });
  addProperty(r.db, table2.id, { name: "Title", type: "text" });
  const site2 = createSite(r.db, { name: "demo2", visibility: "public" });
  setSitePublicGrants(r.db, site2.id, { v: 1, tables: [{ db: table2.id, ops: ["create"] }] });
  await r.host.register(site2.id, {});
  await r.drop.createRecord("guestbook", { Title: "mail for drop 1" });

  // Same local fault as the F5 test: keyring wrapped with a key the attached
  // bucket's master key can't unwrap.
  const kr = getLocalDropKeyring(r.db)!;
  const rec = kr.keys[0]!;
  const wrongMaster = generateMasterKey();
  saveLocalDropKeyring(r.db, {
    v: 1,
    keys: [{ ...rec, sk: toB64(await encryptBytes(wrongMaster, fromB64(rec.sk))), wrapped: true }],
  });
  addBucketPeer(r.db);

  const listed: string[] = [];
  const countingHost: DropHostApi = {
    ...r.host,
    listEnvelopes: (dropId, afterId, limit) => {
      listed.push(dropId);
      return r.host.listEnvelopes(dropId, afterId, limit);
    },
  };
  const s = await pullDropsOnce(r.db, { host: countingHost, ignoreLease: true });
  expect(s.held).toBe(1);
  expect(s.acked).toBe(0);
  // Drop 1 hit the fault; drop 2 was never even listed.
  expect(listed).toEqual([r.site.id]);
  // Nothing lost: the mail is still on the host for a fixed-key retry.
  expect(await r.host.listEnvelopes(r.site.id, 0, 100)).toHaveLength(1);
});

test("tampered ciphertext under a KNOWN, unwrappable key is rejected+deleted, never held", async () => {
  // Pins the held/reject classification boundary: held is EXCLUSIVELY for the
  // local dropKeySecret fault (see the F5 test above); an auth failure from
  // openDropEnvelope (garbage/tampered ciphertext, good key) is bad MAIL and
  // must be rejected+deleted, or an attacker pins inbox capacity with
  // unopenable envelopes. A refactor that makes key-unwrap lazy (auth surfacing
  // from openDropEnvelope for local faults) would flip held→delete for legit
  // mail — this test + the F5 test together make that flip impossible to miss.
  const r = await rig();
  await r.drop.createRecord("guestbook", { Title: "legit" });
  const original = (await r.host.listEnvelopes(r.site.id, 0, 100))[0]!.envelope as Record<string, unknown>;

  // Drain the legit envelope first (no bucket → immediate ack).
  const s1 = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s1.acked).toBe(1);

  // Same key_id (known + unwrappable), corrupted sealed bytes, fresh id.
  const tampered = JSON.stringify({
    ...original,
    envelope_id: original.envelope_id + "-t",
    sealed: (original.sealed as string).slice(0, -8) + "AAAAAAAA",
  });
  await createInboxFetch({ sql: r.sql, ownerToken: OWNER })(
    new Request(`${ENDPOINT}/v1/inbox/${r.site.id}/envelopes`, { method: "POST", body: tampered }),
  );

  const s2 = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s2.rejected).toBe(1);
  expect(s2.held).toBe(0);
  expect(s2.ingested).toBe(0);
  expect(await r.host.listEnvelopes(r.site.id, 0, 100)).toHaveLength(0); // deleted, not pinned
  const rejects = r.db.query("SELECT COUNT(*) AS n FROM drop_rejects WHERE drop_id = ?").get(r.site.id) as {
    n: number;
  };
  expect(rejects.n).toBe(1);
});

test("new-envelope_id replay acks + deletes instead of deferring forever (inbox-DoS fix, F6)", async () => {
  const r = await rig();
  setSitePublicGrants(r.db, r.site.id, { v: 1, tables: [{ db: r.dbId, ops: ["create", "update"] }] });
  const url = addBucketPeer(r.db);
  await r.drop.createRecord("guestbook", { Title: "original" });

  // Round 1: ingested, deferred (cursor 0). Capture the envelope for replay.
  const s1 = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s1.deferred).toBe(1);
  const original = (await r.host.listEnvelopes(r.site.id, 0, 100))[0]!.envelope as Record<string, unknown>;

  // Advance the bucket cursor → the original acks + drains.
  const max = (r.db.query("SELECT MAX(seq) AS s FROM crdt_changes").get() as { s: number }).s;
  r.db.query("UPDATE peers SET push_cursor = ? WHERE url = ?").run(max, url);
  const s2 = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s2.acked).toBe(1);
  expect(await r.host.listEnvelopes(r.site.id, 0, 100)).toHaveLength(0);

  // Attacker replays the SAME sealed payload under a NEW envelope_id.
  const replay = JSON.stringify({ ...original, envelope_id: original.envelope_id + "-r" });
  await createInboxFetch({ sql: r.sql, ownerToken: OWNER })(
    new Request(`${ENDPOINT}/v1/inbox/${r.site.id}/envelopes`, { method: "POST", body: replay }),
  );
  expect(await r.host.listEnvelopes(r.site.id, 0, 100)).toHaveLength(1);

  // The replay ingests 0 rows (oplog UNIQUE) but MUST ack+delete — the old
  // txn-keyed watermark would leave it deferred forever, pinning capacity.
  const s3 = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s3.ingested).toBe(0);
  expect(s3.deferred).toBe(0);
  expect(s3.acked).toBe(1);
  expect(await r.host.listEnvelopes(r.site.id, 0, 100)).toHaveLength(0);
  expect(listRecords(r.db, r.dbId)).toHaveLength(1); // still exactly one, no dup
});

test("two replicas double-pull the same inbox and converge with zero duplicates", async () => {
  const r = await rig("nodeone1");
  // Replica: same workspace state (site/grants/schema) + same keyring, no bucket.
  const db2 = new Database(":memory:");
  runSchema(db2);
  db2.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run("nodetwo2");
  ingest(db2, changesSince(r.db, ""));
  setEdgeConfig(db2, { endpoint: ENDPOINT, token: OWNER });
  saveLocalDropKeyring(db2, getLocalDropKeyring(r.db)!);

  await r.drop.createRecord("guestbook", { Title: "seen by both" });

  // Device 1 has a bucket whose cursor lags → it ingests but defers the ack,
  // leaving the envelope for device 2 to double-pull.
  addBucketPeer(r.db);
  const s1 = await pullDropsOnce(r.db, { host: r.host, ignoreLease: true });
  expect(s1.deferred).toBe(1);
  const s2 = await pullDropsOnce(db2, { host: r.host, ignoreLease: true });
  expect(s2.ingested).toBeGreaterThan(0);
  expect(s2.acked).toBe(1); // no bucket on device 2 → local oplog is the anchor

  // Both replicas hold exactly one identical record; cross-sync adds nothing.
  const rows1 = listRecords(r.db, r.dbId);
  const rows2 = listRecords(db2, r.dbId);
  expect(rows1).toHaveLength(1);
  expect(rows2).toHaveLength(1);
  expect(rows1[0]!.id).toBe(rows2[0]!.id);
  expect(ingest(r.db, changesSince(db2, ""))).toBe(0); // dbs already converged
});

test("skip states: no edge config / no wired sites", async () => {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', 'hostnode')").run();
  expect((await pullDropsOnce(db)).skipped).toBe("no_edge");
  setEdgeConfig(db, { endpoint: ENDPOINT, token: OWNER });
  expect((await pullDropsOnce(db)).skipped).toBe("no_sites");
});

test("ack gate accounts for EVERY op: landed or superseded → seq; any op missing → null (no partial ack)", () => {
  // The gate that decides ack-vs-hold. A partial ingest (one op poison-skipped)
  // must yield null — acking would delete the envelope and permanently lose
  // that guest write. A superseded op (newer register winner, incl. compacted
  // history) still counts as accounted for, so old mail can't wedge as held.
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', 'hostnode')").run();

  const c1 = emit(db, "documents", "doc_g", "title", "one");
  const c2 = emit(db, "documents", "doc_g", "body", "two");

  // All landed → the max of their seqs (non-null).
  const all = changesMaxSeq(db, [c1, c2]);
  expect(all).not.toBeNull();

  // One op absent from the oplog (poison-skipped) → null, never a partial max.
  const ghost = { ...c2, col: "order_key", hlc: c2.hlc.replace(/^\d/, "8") };
  expect(changesMaxSeq(db, [c1, ghost])).toBeNull();

  // Superseded: the payload's op predates the register's current winner and its
  // own row is gone (compacted) — `hlc >=` resolves to the newer winner → accounted.
  const newer = emit(db, "documents", "doc_g", "title", "newer");
  db.query("DELETE FROM crdt_changes WHERE hlc = ?").run(c1.hlc); // compact the old op
  const superseded = changesMaxSeq(db, [c1, c2]);
  expect(superseded).not.toBeNull();
  expect(newer.hlc > c1.hlc).toBe(true);
});
