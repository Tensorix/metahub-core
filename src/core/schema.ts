export const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- CRDT oplog: one row per field assignment. Source of truth for sync.
CREATE TABLE IF NOT EXISTS crdt_changes (
  hlc     TEXT NOT NULL,
  node_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  row_id  TEXT NOT NULL,
  col     TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (dataset, row_id, col, hlc)
);
CREATE INDEX IF NOT EXISTS idx_changes_hlc ON crdt_changes(hlc);

-- Per-peer replication cursors (SQLite rowids: monotonic in insertion order,
-- so no change is ever skipped regardless of HLC/clock skew).
CREATE TABLE IF NOT EXISTS peers (
  url         TEXT PRIMARY KEY,
  pull_cursor INTEGER NOT NULL DEFAULT 0,
  push_cursor INTEGER NOT NULL DEFAULT 0
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
  __deleted   INTEGER NOT NULL DEFAULT 0
);

-- Document body as an ordered list of blocks; each (block,field) is an
-- independent CRDT register so concurrent edits to different blocks merge.
-- order_key is a fractional index (ties broken by id) giving display order.
CREATE TABLE IF NOT EXISTS doc_blocks (
  id        TEXT PRIMARY KEY,
  doc_id    TEXT,
  text      TEXT,
  order_key TEXT,
  __deleted INTEGER NOT NULL DEFAULT 0
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
