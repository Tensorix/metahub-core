// Server-level configuration, persisted in the `meta` table (same pattern as
// getNodeId / context.ts). These are local-machine settings — they never enter
// the CRDT oplog and never sync to peers. `mh --server` reads them as defaults
// (CLI flags still win); `mh config` and the WebUI settings page edit them.

import type { DbDriver } from "./driver.ts";
import { parseDuration } from "./sync/token.ts";

/** Authoritative upper bound for a single POST /api/blob upload (bytes). The
 *  WebUI applies friendlier per-kind caps (image 25MB / av 100MB / file 100MB)
 *  client-side; this is the hard server ceiling. Override with METAHUB_MAX_BLOB_UPLOAD. */
export const MAX_BLOB_UPLOAD_BYTES = Number(process.env.METAHUB_MAX_BLOB_UPLOAD) || 100 * 1024 * 1024;

const K_HOST = "cfg_host";
const K_PORT = "cfg_port";
const K_SYNC_INTERVAL = "cfg_sync_interval";
const K_AUTO_SYNC = "cfg_auto_sync";
const K_BLOB_QUOTA = "cfg_blob_quota";
const K_PUBLIC_BASE_URL = "cfg_public_base_url";

export interface ServerConfig {
  host: string;
  port: number;
  /** Auto-sync poll interval in ms; <= 0 disables the timer. */
  syncIntervalMs: number;
  autoSync: boolean;
  /** Local blob cache quota in bytes. When the cache exceeds it, the sync tick
   *  auto-evicts clearable, unpinned blobs (LRU). <= 0 disables eviction. */
  blobCacheQuotaBytes: number;
  /** Reachable base used for site/share links. Node-local and never synced. */
  publicBaseUrl: string | null;
}

export const DEFAULT_CONFIG: ServerConfig = {
  host: "127.0.0.1",
  port: 7777,
  syncIntervalMs: parseDuration(process.env.METAHUB_SYNC_INTERVAL, 30_000),
  autoSync: true,
  blobCacheQuotaBytes: Number(process.env.METAHUB_BLOB_QUOTA) || 2 * 1024 * 1024 * 1024,
  publicBaseUrl: null,
};

export type PublicBaseScope = "local" | "lan" | "public";

function isPrivateV4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const n = m.slice(1).map(Number);
  if (n.some((x) => x < 0 || x > 255)) return false;
  return (
    n[0] === 10 ||
    n[0] === 127 ||
    (n[0] === 172 && n[1]! >= 16 && n[1]! <= 31) ||
    (n[0] === 192 && n[1] === 168) ||
    (n[0] === 169 && n[1] === 254)
  );
}

function isPrivateV6(host: string): boolean {
  return (
    host === "::1" ||
    /^[fd][0-9a-f]{1,3}(?::|$)/i.test(host) ||
    /^fe[89ab][0-9a-f](?::|$)/i.test(host)
  );
}

/** Normalize and classify a site-hosting base. HTTP is deliberately limited
 *  to loopback/private networks; an Internet-facing base must terminate TLS. */
export function normalizePublicBaseUrl(input: string): {
  url: string;
  scope: PublicBaseScope;
} {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error("请输入完整的 http(s) 地址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("站点入口只支持 HTTP 或 HTTPS");
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("站点入口不能包含凭据、查询参数或片段");
  if (parsed.pathname !== "/" && parsed.pathname !== "")
    throw new Error("站点入口必须是域名根地址，不能包含路径");
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const local = host === "localhost" || isPrivateV4(host) || isPrivateV6(host);
  if (parsed.protocol === "http:" && !local)
    throw new Error("公网入口必须使用 HTTPS；HTTP 仅允许本机或局域网地址");
  parsed.pathname = "";
  const url = parsed.toString().replace(/\/+$/, "");
  return {
    url,
    scope: local
      ? host === "localhost" || host === "::1" || host === "127.0.0.1"
        ? "local"
        : "lan"
      : "public",
  };
}

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
  const publicBaseUrl = getMeta(db, K_PUBLIC_BASE_URL);
  return {
    host: host ?? DEFAULT_CONFIG.host,
    port: port != null ? Number(port) : DEFAULT_CONFIG.port,
    syncIntervalMs: interval != null ? Number(interval) : DEFAULT_CONFIG.syncIntervalMs,
    autoSync: auto != null ? auto === "1" : DEFAULT_CONFIG.autoSync,
    blobCacheQuotaBytes:
      blobQuota != null ? Number(blobQuota) : DEFAULT_CONFIG.blobCacheQuotaBytes,
    publicBaseUrl: publicBaseUrl || null,
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
  if (partial.publicBaseUrl !== undefined) {
    const value = partial.publicBaseUrl?.trim();
    setMeta(db, K_PUBLIC_BASE_URL, value ? normalizePublicBaseUrl(value).url : "");
  }
  return getServerConfig(db);
}
