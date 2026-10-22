CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  descriptor TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS share_links_expiry ON share_links(expires_at);
CREATE TABLE IF NOT EXISTS share_link_limits (
  scope TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS share_link_limits_expiry ON share_link_limits(expires_at);
