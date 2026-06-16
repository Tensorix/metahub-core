// Server-level configuration, persisted in the `meta` table (same pattern as
// getNodeId / context.ts). These are local-machine settings — they never enter
// the CRDT oplog and never sync to peers. `mh --server` reads them as defaults
// (CLI flags still win); `mh config` and the WebUI settings page edit them.

import type { DbDriver } from "./driver.ts";
import { parseDuration } from "./sync/token.ts";

const K_HOST = "cfg_host";
const K_PORT = "cfg_port";
const K_SYNC_INTERVAL = "cfg_sync_interval";
const K_AUTO_SYNC = "cfg_auto_sync";
const K_BLOB_QUOTA = "cfg_blob_quota";

export interface ServerConfig {
  host: string;
  port: number;
  /** Auto-sync poll interval in ms; <= 0 disables the timer. */
  syncIntervalMs: number;
  autoSync: boolean;
  /** Local blob cache quota in bytes. When the cache exceeds it, the sync tick
   *  auto-evicts clearable, unpinned blobs (LRU). <= 0 disables eviction. */
  blobCacheQuotaBytes: number;
}

export const DEFAULT_CONFIG: ServerConfig = {
  host: "127.0.0.1",
  port: 7777,
  syncIntervalMs: parseDuration(process.env.METAHUB_SYNC_INTERVAL, 30_000),
  autoSync: true,
  blobCacheQuotaBytes: Number(process.env.METAHUB_BLOB_QUOTA) || 2 * 1024 * 1024 * 1024,
};

function getMeta(db: DbDriver, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row ? row.value : null;
}

function setMeta(db: DbDriver, key: string, value: string): void {
  db.query(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** Persisted server config, falling back to DEFAULT_CONFIG per field. */
export function getServerConfig(db: DbDriver): ServerConfig {
  const host = getMeta(db, K_HOST);
  const port = getMeta(db, K_PORT);
  const interval = getMeta(db, K_SYNC_INTERVAL);
  const auto = getMeta(db, K_AUTO_SYNC);
  const blobQuota = getMeta(db, K_BLOB_QUOTA);
  return {
    host: host ?? DEFAULT_CONFIG.host,
    port: port != null ? Number(port) : DEFAULT_CONFIG.port,
    syncIntervalMs: interval != null ? Number(interval) : DEFAULT_CONFIG.syncIntervalMs,
    autoSync: auto != null ? auto === "1" : DEFAULT_CONFIG.autoSync,
    blobCacheQuotaBytes:
      blobQuota != null ? Number(blobQuota) : DEFAULT_CONFIG.blobCacheQuotaBytes,
  };
}

/** Persist a partial config update. Only provided fields are written. */
export function setServerConfig(db: DbDriver, partial: Partial<ServerConfig>): ServerConfig {
  if (partial.host != null) setMeta(db, K_HOST, partial.host);
  if (partial.port != null) setMeta(db, K_PORT, String(partial.port));
  if (partial.syncIntervalMs != null)
    setMeta(db, K_SYNC_INTERVAL, String(partial.syncIntervalMs));
  if (partial.autoSync != null) setMeta(db, K_AUTO_SYNC, partial.autoSync ? "1" : "0");
  if (partial.blobCacheQuotaBytes != null)
    setMeta(db, K_BLOB_QUOTA, String(partial.blobCacheQuotaBytes));
  return getServerConfig(db);
}
