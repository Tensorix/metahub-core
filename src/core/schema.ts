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

CREATE TABLE IF NOT EXISTS databases (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  icon        TEXT,
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
  __deleted   INTEGER NOT NULL DEFAULT 0
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
-- Gives the bare hash-named files the metadata clearing/stats need (size,
-- content_type, last access). hash is the canonical content key (sha256 truncated
-- to 32 hex; legacy 64-hex entries coexist — addressing is length-agnostic).
CREATE TABLE IF NOT EXISTS blob_cache (
  hash         TEXT PRIMARY KEY,
  size         INTEGER NOT NULL,
  content_type TEXT,
  last_access  INTEGER
);

-- Synced blob presence: which node holds which blob's bytes. Only "full blob
-- devices" (see blob_policy) announce rows here, after the bytes are durably
-- stored, so other devices can decide OFFLINE whether a local blob is safe to
-- clear (present on the required full set ⇒ re-fetchable later). row id is
-- "<node_id>~<hash>" so each device's claim is an independent CRDT register.
CREATE TABLE IF NOT EXISTS blob_presence (
  id        TEXT PRIMARY KEY,   -- "<node_id>~<hash>"
  node_id   TEXT,
  hash      TEXT,
  present   INTEGER NOT NULL DEFAULT 1,
  size      INTEGER,
  __deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_blob_presence_hash ON blob_presence(hash);

-- Synced workspace policy (single row "default"): which nodes are designated
-- full-blob libraries and the redundancy rule used to gate clearing. full_nodes
-- is a JSON array of node_id; redundancy is 'all' (clearable only when every
-- full node holds it) or 'any'.
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
