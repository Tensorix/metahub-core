import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  runSchema,
  initSchema,
  migrateOplog,
  migratePeers,
  migrateCrdtChangesSeq,
  migrateStoragePeerUrls,
  migrateSitesAccess,
} from "./schema-init.ts";
import { readPolicy, setFullNodes } from "./blobs-core.ts";

function hasCol(db: Database, table: string, col: string): boolean {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
    (c) => c.name === col,
  );
}

function hasIndex(db: Database, name: string): boolean {
  return db.query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) != null;
}

test("runSchema creates the storage_cursors table", () => {
  const db = new Database(":memory:");
  runSchema(db);
  const t = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='storage_cursors'")
    .get();
  expect(t).not.toBeNull();
  expect(hasIndex(db, "idx_changes_txn")).toBe(true);
  expect(hasIndex(db, "idx_changes_intent_receipt_hlc")).toBe(true);
});

test("initSchema adds request_id before creating its index on a legacy shares table", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE shares (
    slug TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    permission TEXT NOT NULL,
    transport TEXT NOT NULL,
    pw_salt TEXT,
    pw_hash TEXT,
    expires_at INTEGER,
    guest_node_id TEXT,
    served_base TEXT,
    s3_peer_url TEXT,
    s3_object_prefix TEXT,
    s3_presign_exp INTEGER,
    s3_key_b64 TEXT,
    created_at INTEGER NOT NULL,
    grants TEXT
  )`);

  expect(() => initSchema(db)).not.toThrow();
  expect(hasCol(db, "shares", "request_id")).toBe(true);
  expect(hasIndex(db, "idx_shares_request_id")).toBe(true);
});

test("migrateOplog adds the sparse txn index to an existing current-shape table", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE crdt_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    hlc TEXT NOT NULL, node_id TEXT NOT NULL, dataset TEXT NOT NULL,
    row_id TEXT NOT NULL, col TEXT NOT NULL, value TEXT, txn TEXT,
    UNIQUE (dataset, row_id, col, hlc)
  )`);
  migrateOplog(db);
  expect(hasIndex(db, "idx_changes_txn")).toBe(true);
  expect(hasIndex(db, "idx_changes_intent_receipt_hlc")).toBe(true);
});

test("migratePeers adds kind/config to a legacy peers table, preserving cursors", () => {
  const db = new Database(":memory:");
  // Legacy shape: only the original three columns, no pairing/storage columns.
  db.exec("CREATE TABLE peers (url TEXT PRIMARY KEY, pull_cursor INTEGER, push_cursor INTEGER)");
  db.query("INSERT INTO peers (url, pull_cursor, push_cursor) VALUES ('http://x', 5, 7)").run();

  migratePeers(db);
  expect(hasCol(db, "peers", "kind")).toBe(true);
  expect(hasCol(db, "peers", "config")).toBe(true);
  expect(hasCol(db, "peers", "last_success_at")).toBe(true);
  expect(hasCol(db, "peers", "token")).toBe(true); // older pairing columns too

  const row = db
    .query("SELECT pull_cursor, push_cursor, kind FROM peers WHERE url='http://x'")
    .get() as { pull_cursor: number; push_cursor: number; kind: string };
  expect(row.pull_cursor).toBe(5); // cursors survive the migration
  expect(row.push_cursor).toBe(7);
  expect(row.kind).toBe("http"); // existing rows backfill to the default transport
});

test("migratePeers backfills last_success_at from a previous successful sync", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE peers (
    url TEXT PRIMARY KEY,
    pull_cursor INTEGER,
    push_cursor INTEGER,
    last_sync_at INTEGER,
    last_status TEXT
  )`);
  db.query(
    "INSERT INTO peers (url, pull_cursor, push_cursor, last_sync_at, last_status) VALUES (?, 0, 0, ?, ?)",
  ).run("http://ok", 123, "ok");
  db.query(
    "INSERT INTO peers (url, pull_cursor, push_cursor, last_sync_at, last_status) VALUES (?, 0, 0, ?, ?)",
  ).run("http://err", 456, "error");

  migratePeers(db);

  const ok = db.query("SELECT last_success_at FROM peers WHERE url = 'http://ok'").get() as {
    last_success_at: number | null;
  };
  const err = db.query("SELECT last_success_at FROM peers WHERE url = 'http://err'").get() as {
    last_success_at: number | null;
  };
  expect(ok.last_success_at).toBe(123);
  expect(err.last_success_at).toBeNull();
});

test("migratePeers is idempotent (running twice is a no-op)", () => {
  const db = new Database(":memory:");
  runSchema(db); // already-current schema
  expect(() => {
    migratePeers(db);
    migratePeers(db);
  }).not.toThrow();
  expect(hasCol(db, "peers", "config")).toBe(true);
});

test("migrateCrdtChangesSeq rebuilds a legacy oplog with a stable AUTOINCREMENT seq", () => {
  const db = new Database(":memory:");
  // Legacy shape: composite PK, no `seq`, so rowid is the implicit (and
  // VACUUM-renumberable) one the cursor bug rode on.
  db.exec(`CREATE TABLE crdt_changes (
    hlc TEXT NOT NULL, node_id TEXT NOT NULL, dataset TEXT NOT NULL,
    row_id TEXT NOT NULL, col TEXT NOT NULL, value TEXT, txn TEXT,
    PRIMARY KEY (dataset, row_id, col, hlc)
  )`);
  db.exec("CREATE TABLE peers (url TEXT PRIMARY KEY, pull_cursor INTEGER, push_cursor INTEGER)");
  db.query("INSERT INTO peers (url, pull_cursor, push_cursor) VALUES ('http://x', 9, 9)").run();
  const ins = db.query(
    "INSERT INTO crdt_changes (hlc, node_id, dataset, row_id, col, value) VALUES (?,?,?,?,?,?)",
  );
  for (let i = 0; i < 3; i++) ins.run(`00000000000000${i}-0000-n`, "n", "d", `r${i}`, "c", `${i}`);

  expect(hasCol(db, "crdt_changes", "seq")).toBe(false);
  migrateCrdtChangesSeq(db);

  expect(hasCol(db, "crdt_changes", "seq")).toBe(true);
  expect(hasIndex(db, "idx_changes_txn")).toBe(true);
  expect(hasIndex(db, "idx_changes_intent_receipt_hlc")).toBe(true);
  const rows = db.query("SELECT seq, row_id FROM crdt_changes ORDER BY seq").all() as {
    seq: number;
    row_id: string;
  }[];
  expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]); // old rowids copied verbatim
  // A fresh insert continues the sequence — never reused/renumbered.
  ins.run("0000000000000099-0000-n", "n", "d", "r9", "c", "9");
  expect((db.query("SELECT MAX(seq) AS m FROM crdt_changes").get() as { m: number }).m).toBe(4);
  // Dedup still works via the UNIQUE(dataset,row_id,col,hlc) constraint.
  db.query(
    "INSERT OR IGNORE INTO crdt_changes (hlc, node_id, dataset, row_id, col, value) VALUES (?,?,?,?,?,?)",
  ).run("0000000000000099-0000-n", "n", "d", "r9", "c", "dupe");
  expect((db.query("SELECT COUNT(*) AS n FROM crdt_changes").get() as { n: number }).n).toBe(4);
  // Cursors reset: we can't tell which a past VACUUM already stranded.
  const p = db.query("SELECT pull_cursor, push_cursor FROM peers WHERE url='http://x'").get() as {
    pull_cursor: number;
    push_cursor: number;
  };
  expect(p.pull_cursor).toBe(0);
  expect(p.push_cursor).toBe(0);
});

test("migrateStoragePeerUrls folds the endpoint into the peer key across all references", () => {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', 'self')").run();

  const oldUrl = "s3://backups/metahub"; // legacy bucket+prefix key
  const config = JSON.stringify({
    endpoint: "https://s3.us-east-1.amazonaws.com",
    bucket: "backups",
    prefix: "metahub",
  });
  db.query("INSERT INTO peers (url, kind, config, enabled, pull_cursor, push_cursor) VALUES (?, 's3', ?, 1, 0, 0)").run(oldUrl, config);
  db.query("INSERT INTO storage_cursors (peer_url, node_id, last_key) VALUES (?, 'peerNode', 'k')").run(oldUrl);
  setFullNodes(db, [oldUrl]); // bucket designated as a full-blob anchor

  migrateStoragePeerUrls(db);

  const newUrl = "s3://s3.us-east-1.amazonaws.com/backups/metahub";
  expect(db.query("SELECT url FROM peers WHERE kind='s3'").get()).toEqual({ url: newUrl });
  expect(
    db.query("SELECT peer_url FROM storage_cursors").get(),
  ).toEqual({ peer_url: newUrl });
  expect(readPolicy(db).fullNodes).toEqual([newUrl]);
});

test("migrateStoragePeerUrls is idempotent and lets same-bucket endpoints coexist", () => {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', 'self')").run();

  // Same bucket+prefix on two different endpoints — used to collide on one key.
  db.query("INSERT INTO peers (url, kind, config, enabled, pull_cursor, push_cursor) VALUES (?, 's3', ?, 1, 0, 0)").run(
    "s3://shared/data",
    JSON.stringify({ endpoint: "https://a.r2.example.com", bucket: "shared", prefix: "data" }),
  );

  migrateStoragePeerUrls(db);
  const first = db.query("SELECT url FROM peers").get() as { url: string };
  expect(first.url).toBe("s3://a.r2.example.com/shared/data");

  // A second endpoint's same-named bucket now gets its own distinct key.
  db.query("INSERT INTO peers (url, kind, config, enabled, pull_cursor, push_cursor) VALUES (?, 's3', ?, 1, 0, 0)").run(
    "s3://b.minio.example.com/shared/data",
    JSON.stringify({ endpoint: "https://b.minio.example.com", bucket: "shared", prefix: "data" }),
  );
  migrateStoragePeerUrls(db); // re-run: no-op for both (already endpoint-qualified)

  const urls = (db.query("SELECT url FROM peers ORDER BY url").all() as { url: string }[]).map(
    (r) => r.url,
  );
  expect(urls).toEqual(["s3://a.r2.example.com/shared/data", "s3://b.minio.example.com/shared/data"]);
});

test("migrateStoragePeerUrls skips a rename that would collide on storage_cursors PK (no throw)", () => {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', 'self')").run();

  // Legacy-keyed peer whose canonical key is already occupied by a storage_cursors
  // row — renaming would violate the (peer_url,node_id) PK and brick DB open.
  const oldUrl = "s3://backups/metahub";
  const newUrl = "s3://s3.amazonaws.com/backups/metahub";
  db.query("INSERT INTO peers (url, kind, config, enabled, pull_cursor, push_cursor) VALUES (?, 's3', ?, 1, 0, 0)").run(
    oldUrl,
    JSON.stringify({ endpoint: "https://s3.amazonaws.com", bucket: "backups", prefix: "metahub" }),
  );
  db.query("INSERT INTO storage_cursors (peer_url, node_id, last_key) VALUES (?, 'n', 'k')").run(newUrl);

  expect(() => migrateStoragePeerUrls(db)).not.toThrow();
  // Left as-is rather than renamed onto the occupied key.
  expect(db.query("SELECT url FROM peers WHERE kind='s3'").get()).toEqual({ url: oldUrl });
});

test("migrateStoragePeerUrls maps two legacy rows that canonicalize to one key without colliding", () => {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', 'self')").run();

  // Two rows whose endpoints differ only by an explicit :443 → same canonical key.
  db.query("INSERT INTO peers (url, kind, config, enabled, pull_cursor, push_cursor) VALUES (?, 's3', ?, 1, 0, 0)").run(
    "s3://h.example.com/b/p",
    JSON.stringify({ endpoint: "https://h.example.com", bucket: "b", prefix: "p" }),
  );
  db.query("INSERT INTO peers (url, kind, config, enabled, pull_cursor, push_cursor) VALUES (?, 's3', ?, 1, 0, 0)").run(
    "s3://legacy/b/p", // legacy-shaped, canonicalizes to s3://h.example.com/b/p
    JSON.stringify({ endpoint: "https://h.example.com:443", bucket: "b", prefix: "p" }),
  );

  expect(() => migrateStoragePeerUrls(db)).not.toThrow();
  // One row already canonical; the other is left rather than renamed onto it.
  const urls = (db.query("SELECT url FROM peers ORDER BY url").all() as { url: string }[]).map((r) => r.url);
  expect(urls).toContain("s3://h.example.com/b/p");
  expect(new Set(urls).size).toBe(urls.length); // no duplicate key
});

test("migrateCrdtChangesSeq is idempotent on the current schema", () => {
  const db = new Database(":memory:");
  runSchema(db); // already has seq
  expect(() => {
    migrateCrdtChangesSeq(db);
    migrateCrdtChangesSeq(db);
  }).not.toThrow();
  expect(hasCol(db, "crdt_changes", "seq")).toBe(true);
});

// ---- migrateSitesAccess -------------------------------------------------------

test("migrateSitesAccess adds visibility/spa to a legacy sites table (idempotent)", () => {
  const db = new Database(":memory:");
  // Legacy shape: the pre-Batch-4 sites table + an oplog to backfill from.
  db.exec(`CREATE TABLE sites (
    id TEXT PRIMARY KEY, name TEXT, title TEXT, created_hlc TEXT,
    __deleted INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TABLE crdt_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, hlc TEXT NOT NULL, node_id TEXT NOT NULL,
    dataset TEXT NOT NULL, row_id TEXT NOT NULL, col TEXT NOT NULL, value TEXT, txn TEXT,
    UNIQUE (dataset, row_id, col, hlc)
  )`);
  db.query("INSERT INTO sites (id, name) VALUES ('site_a', 'a'), ('site_b', 'b')").run();

  migrateSitesAccess(db);
  expect(hasCol(db, "sites", "visibility")).toBe(true);
  expect(hasCol(db, "sites", "spa")).toBe(true);
  const a = db.query("SELECT visibility, spa FROM sites WHERE id='site_a'").get() as {
    visibility: string | null;
    spa: number;
  };
  expect(a.visibility).toBeNull(); // no oplog history → defaults
  expect(a.spa).toBe(0);

  // idempotent: a second run is a no-op
  migrateSitesAccess(db);
  expect(
    (db.query("PRAGMA table_info(sites)").all() as { name: string }[]).filter(
      (c) => c.name === "spa",
    ).length,
  ).toBe(1);
});

test("migrateSitesAccess backfills from the max-HLC winning oplog change", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE sites (
    id TEXT PRIMARY KEY, name TEXT, title TEXT, created_hlc TEXT,
    __deleted INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TABLE crdt_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, hlc TEXT NOT NULL, node_id TEXT NOT NULL,
    dataset TEXT NOT NULL, row_id TEXT NOT NULL, col TEXT NOT NULL, value TEXT, txn TEXT,
    UNIQUE (dataset, row_id, col, hlc)
  )`);
  db.query("INSERT INTO sites (id, name) VALUES ('site_a', 'a')").run();
  // An OLD binary ingested these from a newer peer: stored in the oplog, never
  // materialized (unknown column then). Values are JSON-encoded, as emit stores
  // them; the LOSING older change must not win.
  const ins = db.query(
    "INSERT INTO crdt_changes (hlc, node_id, dataset, row_id, col, value) VALUES (?, 'peer', 'sites', 'site_a', ?, ?)",
  );
  ins.run("0000000000001-0000-peer", "visibility", JSON.stringify("private"));
  ins.run("0000000000002-0000-peer", "visibility", JSON.stringify("public")); // winner
  ins.run("0000000000002-0000-peer", "spa", JSON.stringify(1));

  migrateSitesAccess(db);
  const a = db.query("SELECT visibility, spa FROM sites WHERE id='site_a'").get() as {
    visibility: string | null;
    spa: number;
  };
  expect(a.visibility).toBe("public"); // unwrapped from its JSON encoding
  expect(a.spa).toBe(1);

  // a synced null register must not violate spa's NOT NULL — COALESCE → 0
  db.query("INSERT INTO sites (id, name) VALUES ('site_n', 'n')").run();
  db.query(
    "INSERT INTO crdt_changes (hlc, node_id, dataset, row_id, col, value) VALUES ('0000000000003-0000-peer', 'peer', 'sites', 'site_n', 'spa', NULL)",
  ).run();
  db.exec("ALTER TABLE sites DROP COLUMN spa");
  migrateSitesAccess(db);
  const n = db.query("SELECT spa FROM sites WHERE id='site_n'").get() as { spa: number };
  expect(n.spa).toBe(0);
});

// ── migrateSiteChannels: incremental watermark ────────────────────────────────

import { migrateSiteChannels } from "./schema-init.ts";
import { createSite } from "./sites-core.ts";
import { putSiteChannel } from "./site-channel-store.ts";

function seedChannelDb(): Database {
  const db = new Database(":memory:");
  initSchema(db);
  db.query("INSERT INTO meta (key,value) VALUES ('node_id','node-a')").run();
  const site = createSite(db, { name: "wm-demo" });
  putSiteChannel(db, {
    siteId: site.id,
    audience: "public",
    hosting: "device",
    targetRef: "node-a",
    canonicalUrl: "http://a/sites/wm-demo/",
    policy: { v: 1, tables: [] },
  });
  return db;
}

const watermark = (db: Database): number =>
  Number(
    (db.query("SELECT value FROM meta WHERE key='site_channels_replay_seq'").get() as {
      value: string;
    } | null)?.value ?? 0,
  );

test("migrateSiteChannels advances a watermark and skips already-replayed history", () => {
  const db = seedChannelDb();
  migrateSiteChannels(db);
  const wm = watermark(db);
  const max = (db.query("SELECT MAX(seq) AS m FROM crdt_changes WHERE dataset='site_channels'").get() as { m: number }).m;
  expect(wm).toBe(max);

  // Corrupt a materialized column: a re-open must NOT repair it (the tail was
  // already replayed — nothing below the watermark is rescanned).
  db.query("UPDATE site_channels SET canonical_url = 'corrupted' ").run();
  migrateSiteChannels(db);
  expect(
    (db.query("SELECT canonical_url AS u FROM site_channels").get() as { u: string }).u,
  ).toBe("corrupted");

  // Deleting the watermark degrades to the idempotent full replay → repaired.
  db.query("DELETE FROM meta WHERE key='site_channels_replay_seq'").run();
  migrateSiteChannels(db);
  expect(
    (db.query("SELECT canonical_url AS u FROM site_channels").get() as { u: string }).u,
  ).toBe("http://a/sites/wm-demo/");
});

test("changes ingested past the watermark (old-binary window) are replayed on next open", () => {
  const db = seedChannelDb();
  migrateSiteChannels(db);
  const before = watermark(db);
  // Simulate an old binary appending a synced change without materializing it.
  db.query(
    `INSERT INTO crdt_changes (hlc, node_id, dataset, row_id, col, value)
     SELECT '9999999999999-0000-peerbbbb', 'peerbbbb', 'site_channels', id, 'desired_state', '"revoked"'
     FROM site_channels LIMIT 1`,
  ).run();
  db.query("UPDATE site_channels SET desired_state='active'").run(); // not yet applied
  migrateSiteChannels(db);
  expect(watermark(db)).toBeGreaterThan(before);
  expect(
    (db.query("SELECT desired_state AS d FROM site_channels").get() as { d: string }).d,
  ).toBe("revoked");
});
