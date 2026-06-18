// Single source of truth for the synthetic storage-peer key. Runtime-agnostic
// (no Bun / node imports) so EVERY producer derives the identical key: the CLI
// and server route (peers.ts addAndSyncStoragePeer), the WebUI worker's own add
// path (db-worker addStorageReplica), and the schema migration. Any divergence
// re-creates the very bug this key shape fixes — the same bucket registered two
// ways becomes two peers with independent cursors, and a migration that rewrites
// one producer's output while another keeps emitting the old shape turns into a
// permanent whack-a-mole rename.

export const DEFAULT_STORAGE_PREFIX = "metahub";

const DEFAULT_PORT: Record<string, string> = { "https:": "443", "http:": "80" };

/**
 * Stable host[:port] component of an S3 endpoint for the peer key. The default
 * port is stripped so `https://h` and `https://h:443` collapse to one key (that
 * spurious split is exactly the collision class the endpoint-qualified key is
 * meant to remove). Falls back to a parsed-by-hand host when the endpoint isn't
 * a valid URL, kept deterministic.
 */
export function storageEndpointHost(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    const port = u.port && u.port !== DEFAULT_PORT[u.protocol] ? `:${u.port}` : "";
    return u.hostname + port;
  } catch {
    return endpoint
      .trim()
      .replace(/^[a-z]+:\/\//i, "")
      .replace(/\/.*$/, "")
      .replace(/:(80|443)$/, "");
  }
}

/**
 * Synthetic peer key for a storage peer: one per endpoint+bucket+prefix. The
 * endpoint host is part of the identity because bucket names are only unique
 * within a single S3-compatible endpoint (R2/MinIO/COS each have their own
 * namespace) — without it, the same bucket+prefix on a second endpoint would
 * collide with (and silently overwrite, keeping the stale cursor) the first.
 */
export function storageUrl(endpoint: string, bucket: string, prefix?: string): string {
  const p = prefix?.trim() || DEFAULT_STORAGE_PREFIX;
  return `s3://${storageEndpointHost(endpoint)}/${bucket}/${p}`;
}
