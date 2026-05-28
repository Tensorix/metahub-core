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

CREATE TABLE IF NOT EXISTS records (
  id          TEXT PRIMARY KEY,
  database_id TEXT,
  created_hlc TEXT,
  __deleted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_records_db ON records(database_id);

-- EAV cells; each (record,property) is an independent CRDT register.
CREATE TABLE IF NOT EXISTS record_values (
  record_id   TEXT NOT NULL,
  property_id TEXT NOT NULL,
  value       TEXT,
  PRIMARY KEY (record_id, property_id)
);

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  body        TEXT,
  database_id TEXT,
  parent_id   TEXT,
  created_hlc TEXT,
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
