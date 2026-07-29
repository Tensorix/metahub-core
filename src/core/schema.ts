export const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- CRDT oplog: one row per field assignment. Source of truth for sync.
-- txn groups the changes of one logical mutation for history rendering
-- (nullable: legacy rows and changes from pre-txn peers have none).
--
-- seq is an explicit AUTOINCREMENT id used as the replication cursor. It must
-- be a declared INTEGER PRIMARY KEY (not the implicit rowid): VACUUM renumbers
-- the rowids of tables that lack one, which would shift them below a peer's
-- stored push/pull cursor and silently strand every write in the gap.
-- AUTOINCREMENT additionally guarantees ids are never reused. The
-- (dataset,row_id,col,hlc) tuple stays UNIQUE so applyChange's INSERT OR IGNORE
-- dedup is unchanged. Legacy databases are rebuilt into this shape by
-- migrateCrdtChangesSeq (schema-init.ts).
CREATE TABLE IF NOT EXISTS crdt_changes (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  hlc     TEXT NOT NULL,
  node_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  row_id  TEXT NOT NULL,
  col     TEXT NOT NULL,
  value   TEXT,
  txn     TEXT,
  UNIQUE (dataset, row_id, col, hlc)
);
CREATE INDEX IF NOT EXISTS idx_changes_hlc ON crdt_changes(hlc);
-- GuestIntent idempotency probes by txn prefix on every guest write. Keep the
-- sparse legacy/null majority out of the index.
CREATE INDEX IF NOT EXISTS idx_changes_txn ON crdt_changes(txn)
  WHERE txn IS NOT NULL;
-- Receipt GC is age-based and runs on every intent/sync maintenance path.
CREATE INDEX IF NOT EXISTS idx_changes_intent_receipt_hlc ON crdt_changes(hlc)
  WHERE dataset = 'intent_receipts';
-- Serves history's "every block ever attached to this doc" lookup. Partial so
-- it never indexes the large values other datasets carry (e.g. site file bodies).
CREATE INDEX IF NOT EXISTS idx_changes_docref ON crdt_changes(value)
  WHERE dataset = 'doc_blocks' AND col = 'doc_id';

-- Per-peer replication cursors (crdt_changes.seq: AUTOINCREMENT, monotonic in
-- insertion order and stable across VACUUM, so no change is ever skipped
-- regardless of HLC/clock skew). Outbound side of
-- a pairing: "token" is the credential the *remote* issued to us (sent as a
-- Bearer header when we sync to them). See migratePeers in db.ts for the columns
-- added to legacy databases.
--
-- kind selects the transport: 'http' (POST /sync to a peer server, the classic
-- path) or 's3' (an S3-compatible bucket used as dumb store-and-forward — see
-- sync/storage.ts). For 's3' peers url is a synthetic key (s3://<bucket>/<prefix>)
-- and config holds the bucket settings + credentials + master key as JSON.
-- Like the rest of peers, config is local-only and never enters the CRDT oplog.
CREATE TABLE IF NOT EXISTS peers (
  url          TEXT PRIMARY KEY,
  pull_cursor  INTEGER NOT NULL DEFAULT 0,
  push_cursor  INTEGER NOT NULL DEFAULT 0,
  token        TEXT,
  label        TEXT,
  node_id      TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_sync_at INTEGER,
  last_success_at INTEGER,
  last_status  TEXT,
  last_error   TEXT,
  kind         TEXT NOT NULL DEFAULT 'http',
  config       TEXT
);

-- Per-(storage-peer, remote-node) pull progress: the key of the last oplog
-- segment we consumed from that node's bucket prefix. HTTP peers use the single
-- pull_cursor above; storage peers need one cursor per remote node because each
-- node publishes its own segment stream under its own prefix. last_key is a
-- bucket object key (lexicographically ordered = chronological), so LIST
-- start-after resumes exactly where we left off.
CREATE TABLE IF NOT EXISTS storage_cursors (
  peer_url TEXT NOT NULL,
  node_id  TEXT NOT NULL,
  last_key TEXT,
  PRIMARY KEY (peer_url, node_id)
);

-- Owner-side shadow of a room partition (sync/partition.ts): which (dataset,
-- row_id) pairs THIS node last told a given room peer about. Node-local like
-- peers/storage_cursors — deliberately absent from crdt.ts's DOMAIN map, never
-- in the oplog, never synced (each device keeps its own shadow; cross-device
-- shadow splits are healed by the room protocol's need_baseline/digest layers,
-- not by syncing shadows). peer_key is the peers.url of a kind='room' row.
CREATE TABLE IF NOT EXISTS room_rows (
  peer_key TEXT NOT NULL,
  dataset  TEXT NOT NULL,
  row_id   TEXT NOT NULL,
  PRIMARY KEY (peer_key, dataset, row_id)
);

-- Inbound side of a pairing: credentials *we* issued to remote devices. A peer
-- presents one of these on /sync; acceptsSyncToken() checks it alongside the
-- managed master token. Revoke by deleting the row.
CREATE TABLE IF NOT EXISTS peer_grants (
  token      TEXT PRIMARY KEY,
  peer_url   TEXT,
  node_id    TEXT,
  created_at INTEGER
);

-- One-time pairing codes minted by "mh config peer code" / POST /api/pair/new.
-- Short-lived and single-use: redeemed during the pairing handshake, then the
-- two devices exchange durable peer_grants. used/exp gate redemption.
CREATE TABLE IF NOT EXISTS pairing_codes (
  code       TEXT PRIMARY KEY,
  exp        INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER
);

-- Public capability links to a doc / database / site. Like peers and blob_cache
-- this is node-local and deliberately ABSENT from crdt.ts's DOMAIN map, so it
-- never enters the oplog and never syncs — a share is a property of the access
-- point that minted it, not of the workspace. slug is the unguessable capability
-- in the URL (/share/<slug>). transport selects how it's served: 'server' (the
-- token-exempt /share endpoint on this node) or 's3' (a presigned static export
-- under <prefix>/shares/<slug> in a bucket). permission 'edit' is server-only:
-- a presigned static object can't accept writes. guest_node_id attributes every
-- edit made through an edit-share to one synthetic node (see crdt.ts withNodeId).
-- pw_hash/pw_salt: server path stores a PBKDF2 verifier; the s3 path is E2EE so
-- only pw_salt travels (in the link) and decryption happens in the viewer.
CREATE TABLE IF NOT EXISTS shares (
  slug             TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,   -- 'doc' | 'database' | 'site'
  target_id        TEXT NOT NULL,   -- documents.id / databases.id / sites.id
  permission       TEXT NOT NULL,   -- 'view' | 'edit'
  transport        TEXT NOT NULL,   -- 'server' | 's3'
  pw_salt          TEXT,            -- base64; null = no password
  pw_hash          TEXT,            -- base64 PBKDF2 verifier (server path only)
  expires_at       INTEGER,         -- epoch ms; null = never
  guest_node_id    TEXT,            -- synthetic node id for edit shares (null for view)
  served_base      TEXT,            -- reachable base URL chosen at creation (link / source label)
  s3_peer_url      TEXT,            -- vestigial (s3 shares live in the bucket, not here)
  s3_object_prefix TEXT,            -- vestigial
  s3_presign_exp   INTEGER,         -- vestigial
  s3_key_b64       TEXT,            -- vestigial
  created_at       INTEGER NOT NULL,
  request_id       TEXT,            -- idempotency key for remote share creation
  grants           TEXT             -- serialized GrantSet for /share/<slug>/api/* (node-local like the
                                    -- rest of the row: revoking the share kills the grants with it)
);
CREATE INDEX IF NOT EXISTS idx_shares_target ON shares(target_id);

CREATE TABLE IF NOT EXISTS databases (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  icon        TEXT,
  meta        TEXT,               -- JSON: generic replicated metadata (e.g. UI flags), one LWW register
  created_hlc TEXT,
  __deleted   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS properties (
  id          TEXT PRIMARY KEY,
  database_id TEXT,
  name        TEXT,
  type        TEXT,
  config      TEXT,
  position    REAL,
  __deleted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_properties_db ON properties(database_id);

-- One row per record. Field cells live in the data JSON object, keyed by
-- property id (rename-safe). Each (record,property) is still an independent
-- CRDT register in the oplog; materialize() folds the winner into data via
-- json_set/json_remove. Hot fields get expression indexes on data->>'propid'
-- (see indexing.ts) so filter/sort/limit push down to SQL.
CREATE TABLE IF NOT EXISTS records (
  id          TEXT PRIMARY KEY,
  database_id TEXT,
  created_hlc TEXT,
  order_key   TEXT,
  data        TEXT NOT NULL DEFAULT '{}',
  __deleted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_records_db_hlc ON records(database_id, created_hlc);

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  body        TEXT,        -- materialized cache: serialized from doc_blocks
  database_id TEXT,
  parent_id   TEXT,
  created_hlc TEXT,
  order_key   TEXT,        -- fractional index among siblings (same parent_id); ties broken by created_hlc,id
  __deleted   INTEGER NOT NULL DEFAULT 0
);

-- Document body as an ordered list of blocks; each (block,field) is an
-- independent CRDT register so concurrent edits to different blocks merge.
-- order_key is a fractional index (ties broken by id) giving display order.
CREATE TABLE IF NOT EXISTS doc_blocks (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT,
  text        TEXT,
  order_key   TEXT,
  blank_after INTEGER NOT NULL DEFAULT 0,  -- extra blank lines kept after this block (user spacing)
  __deleted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_doc_blocks_doc ON doc_blocks(doc_id);

-- A named static site (Supabase-Storage-style bucket). Served at /sites/<name>/.
CREATE TABLE IF NOT EXISTS sites (
  id          TEXT PRIMARY KEY,
  name        TEXT,        -- URL slug; resolved by getSiteByName
  title       TEXT,
  created_hlc TEXT,
  visibility  TEXT,        -- exactly 'public' = token-free serving; anything else = private (isSitePublic)
  spa         INTEGER NOT NULL DEFAULT 0,  -- 1 = extension-less misses fall back to index.html
  public_grants TEXT,      -- serialized GrantSet for anonymous /sites/<name>/api/*; synced register,
                           -- readers MUST go through parseGrantSet (default-deny on any junk)
  __deleted   INTEGER NOT NULL DEFAULT 0
);

-- Synced desired-state control plane for each way a site is reachable. Access
-- policy and hosting are separate axes; controller_node_id names the node that
-- owns any node-local secret/cleanup work. Runtime success is NOT synced here
-- (see node-local site_channel_observations below).
CREATE TABLE IF NOT EXISTS site_channels (
  id                 TEXT PRIMARY KEY,
  site_id            TEXT,
  audience           TEXT, -- 'public' | 'link'
  hosting            TEXT, -- 'device' | 'edge'
  controller_node_id TEXT,
  target_ref         TEXT, -- serving node id (device) / capability slug (edge)
  canonical_url      TEXT,
  policy_json        TEXT,
  desired_state      TEXT, -- 'active' | 'revoked'
  created_hlc        TEXT,
  __deleted          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_site_channels_site ON site_channels(site_id);

-- What THIS node has actually observed while applying a channel's desired
-- state. Never replicated: readiness/errors are node-relative facts.
CREATE TABLE IF NOT EXISTS site_channel_observations (
  channel_id       TEXT PRIMARY KEY,
  status           TEXT NOT NULL,
  last_verified_at INTEGER,
  last_error       TEXT
);

-- One row per file in a site. content holds inline utf8/base64 text, or a blob
-- hash (see cache.ts) when encoding = 'blob'. (site_id, path) maps to a stable
-- id so re-uploads merge as a CRDT register instead of duplicating.
CREATE TABLE IF NOT EXISTS site_files (
  id           TEXT PRIMARY KEY,
  site_id      TEXT,
  path         TEXT,
  content_type TEXT,
  encoding     TEXT,       -- 'utf8' | 'base64' | 'blob'
  content      TEXT,
  created_hlc  TEXT,
  __deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_site_files_site ON site_files(site_id);

-- Node-local blob cache ledger (NOT synced, like peers/storage_cursors): one row
-- per blob byte-file held in cache.ts's content-addressed store (~/.metahub/cache).
-- Gives the bare hash-named files the metadata clearing/stats need. hash is the
-- canonical content key (sha256 truncated to 32 hex; legacy 64-hex coexist).
-- pending = bytes produced HERE not yet confirmed flushed to a durable anchor
-- (bucket) — the only blobs a device must protect; never auto-evicted/cleared.
-- pending=0 means a flushed production OR an acquired cache, both safely
-- clearable (re-fetchable). This local fact replaces the old SYNCED blob_presence
-- table — clearing is now purely local/offline. See blobs.ts / 22-blob-sync.
CREATE TABLE IF NOT EXISTS blob_cache (
  hash         TEXT PRIMARY KEY,
  size         INTEGER NOT NULL,
  content_type TEXT,
  last_access  INTEGER,
  pinned       INTEGER NOT NULL DEFAULT 0, -- node-local: never auto-evicted / cleared
  pending      INTEGER NOT NULL DEFAULT 1, -- produced here, not yet flushed to anchor
  anchored     INTEGER NOT NULL DEFAULT 0  -- node-local: last verify confirmed a designated anchor holds it (per redundancy). Drives isClearable; reset on policy change
);

-- Node-local ledger of write-inbox envelopes the ingest isolation layer refused
-- (drop-pull.ts): the reason is recorded here, then the envelope is deleted from
-- the edge host (invalid mail never occupies inbox capacity). NOT synced — like
-- peers/blob_cache, this is a fact about what THIS node saw, not workspace data.
CREATE TABLE IF NOT EXISTS drop_rejects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  drop_id     TEXT NOT NULL,
  envelope_id TEXT,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Synced workspace policy (single row "default"): which nodes are designated
-- full-blob libraries — the durable anchor in no-bucket topologies (they pull
-- everything and never clear). full_nodes is a JSON array of node_id; redundancy
-- is retained but unused since clearing moved to the local pending model.
CREATE TABLE IF NOT EXISTS blob_policy (
  id          TEXT PRIMARY KEY,  -- always "default"
  full_nodes  TEXT,              -- JSON array of node_id
  redundancy  TEXT,              -- 'all' | 'any'
  __deleted   INTEGER NOT NULL DEFAULT 0
);
`;

// Best-effort: FTS5 may not be compiled in. Search falls back to LIKE if this fails.
export const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  kind UNINDEXED,
  id UNINDEXED,
  database_id UNINDEXED,
  title,
  body
);
`;
