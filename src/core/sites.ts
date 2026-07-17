import { join } from "node:path";
import type { DbDriver } from "./driver.ts";
import { blobExists, blobHash, putBlob } from "./cache.ts";
import { MhError } from "./errors.ts";
import {
  type SiteFileRow,
  type FileEncoding,
  INLINE_LIMIT,
  inferContentType,
  normalizeSitePath,
  isTextType,
  isImageType,
  toBytes,
  writeFileRow,
  putFileInline,
  getFileRow,
  resolveSiteFileRow,
  liveFileRowIfSame,
  listFiles,
  deleteFile,
  base64ToBytes,
} from "./sites-core.ts";
import { recordBlob } from "./blobs-core.ts";
import { resolveBlob } from "./blobs.ts";

// A "site" is a named bucket of files (Supabase-Storage-style) served at
// /sites/<name>/. Everything is written through emit() so sites replicate over
// /sync like records and documents. File bytes are stored inline as utf8 (text)
// or base64 (small binaries) so they ride the oplog; large binaries offload to
// the content-addressed cache (encoding="blob"), whose bytes are node-local.
//
// Types, normalization, read paths, AND the inline (utf8/base64) mutations live
// in sites-core.ts (portable — the browser replica authors + serves sites
// offline from the same code). This module adds only the two node-only pieces:
// large-binary blob storage on write and blob byte decoding on serve.

export * from "./sites-core.ts";

// Reserved site files owned by the grant/edge auto-wiring (sync/drop-wire.ts
// RESERVED_SITE_FILES) — --prune must never delete them, or a mirror publish
// would sever the wiring (re-created immediately: delete/recreate oplog churn).
// A small local mirror avoids importing drop-wire's edge deps here.
const RESERVED_PRUNE_EXEMPT: ReadonlySet<string> = new Set(["mh-drop.json", "mh-manifest.json"]);

/** Upload or replace one file. utf8 text and small binaries ride the oplog via
 *  putFileInline (portable); binaries over the inline limit offload to the
 *  node-local blob store (server-only — their bytes don't replicate). */
export async function putFile(
  db: DbDriver,
  siteId: string,
  path: string,
  opts: { data: string | Uint8Array | ArrayBuffer; contentType?: string },
): Promise<SiteFileRow & { changed: boolean }> {
  const cleanPath = normalizeSitePath(path);
  if (!cleanPath) throw new MhError("invalid_input", `invalid file path: ${JSON.stringify(path)}`);
  const contentType = opts.contentType ?? inferContentType(cleanPath);
  if (!isTextType(contentType)) {
    const bytes = toBytes(opts.data);
    // Images always offload to a blob (never base64-inline); other binaries only
    // once they exceed the inline limit.
    if (isImageType(contentType) || bytes.byteLength > INLINE_LIMIT) {
      // Skip-unchanged probe before any blob-store side effect: the register's
      // content field IS the content hash, so a same-hash live row means the
      // whole write is a no-op (re-running putBlob/recordBlob would re-mark a
      // flushed blob as pending, re-pushing it to the bucket for nothing). If
      // the local bytes were cache-evicted we fall through so an unchanged
      // re-publish still self-heals the on-disk copy — writeFileRow then
      // reports changed:false without emitting.
      const hash = blobHash(bytes);
      const same = liveFileRowIfSame(db, siteId, cleanPath, contentType, "blob", hash);
      if (same && (await blobExists(hash))) return { ...same, changed: false };
      const info = await putBlob(bytes);
      recordBlob(db, info.hash, info.size, contentType); // produced here → pending=1
      return writeFileRow(db, siteId, cleanPath, contentType, "blob", info.hash);
    }
  }
  return putFileInline(db, siteId, cleanPath, opts);
}

export interface PublishResult {
  uploaded: string[];
  unchanged: string[];
  pruned: string[];
}

/**
 * Publish a local directory into a site: every file under `dir` uploads via
 * putFile, whose skip-unchanged probe makes a re-publish idempotent (zero
 * oplog rows for files whose bytes didn't change). With `prune`, live remote
 * paths that no longer exist locally are deleted afterwards (mirror mode) —
 * opt-in because deletes are destructive, and reported in full as evidence.
 *
 * Uploads run through a small worker pool (default 8). This is safe because
 * putFile's oplog writes happen synchronously inside withChangeGroup — its
 * await points are only file reads and blob-store writes — so change groups
 * from concurrent workers never interleave. Result arrays are path-sorted for
 * stable output.
 */
export async function publishDirectory(
  db: DbDriver,
  siteId: string,
  dir: string,
  opts: { prune?: boolean; concurrency?: number } = {},
): Promise<PublishResult> {
  const rels = [...new Bun.Glob("**/*").scanSync({ cwd: dir, onlyFiles: true })].sort();
  if (rels.length === 0) throw new Error(`no files found in ${dir}`);
  // api/ is the reserved data-API namespace under /sites/<name>/ — files there
  // still publish (the registers replicate fine) but will never be served.
  const shadowed = rels.filter((rel) => {
    const p = normalizeSitePath(rel);
    return p === "api" || p.startsWith("api/");
  });
  if (shadowed.length)
    console.error(
      `warning: ${shadowed.length} file(s) under api/ are shadowed by the site data API ` +
        `(/sites/<name>/api/* is reserved): ${shadowed.join(", ")}`,
    );
  const uploaded: string[] = [];
  const unchanged: string[] = [];
  let next = 0;
  const width = Math.max(1, Math.min(opts.concurrency ?? 8, rels.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < rels.length) {
        const rel = rels[next++]!;
        const bytes = new Uint8Array(await Bun.file(join(dir, rel)).arrayBuffer());
        const f = await putFile(db, siteId, rel, { data: bytes });
        (f.changed ? uploaded : unchanged).push(rel);
      }
    }),
  );
  const pruned: string[] = [];
  if (opts.prune) {
    // Compare in the register's canonical form — putFile stored under
    // normalizeSitePath(rel), and listFiles returns those canonical paths.
    // mh-drop.json + mh-manifest.json are exempt: the grant auto-wiring owns
    // those files (see sync/drop-wire.ts RESERVED_SITE_FILES), and a mirror
    // publish must not sever the wiring (they'd be re-created right after —
    // pure delete/recreate oplog churn).
    const local = new Set(rels.map((rel) => normalizeSitePath(rel)));
    for (const f of listFiles(db, siteId)) {
      if (RESERVED_PRUNE_EXEMPT.has(f.path)) continue;
      if (!local.has(f.path) && deleteFile(db, siteId, f.path)) pruned.push(f.path);
    }
  }
  uploaded.sort();
  unchanged.sort();
  pruned.sort();
  return { uploaded, unchanged, pruned };
}

/** Upper bound on remote blob resolution from the site-serve path. A miss fans
 *  out to every peer + bucket; without a cap a slow/unreachable source would hang
 *  the (token-gated) /sites/<name>/<asset> request. On timeout we 404 — the local
 *  cache hit is still instant (resolveBlob is local-first), so this only bounds
 *  the self-heal-from-remote tail. */
const SITE_BLOB_RESOLVE_TIMEOUT_MS = 5_000;

/** Decode a file row to its served bytes. utf8/base64 decode inline; a blob
 *  hash resolves on demand (local cache → HTTP peer → bucket) so a published
 *  asset whose local bytes were cache-evicted still serves from a bucket/peer
 *  instead of 404ing, consistent with /blob. resolveBlob touches the LRU on a
 *  local hit and caches any remote fetch. Bounded so a slow source can't hang
 *  the serve path (null on timeout; an in-flight fetch still finishes and
 *  populates the cache for the next request). */
export async function decodeFileRow(
  db: DbDriver,
  row: Pick<SiteFileRow, "encoding" | "content">,
): Promise<Uint8Array | null> {
  const content = row.content ?? "";
  if (row.encoding === "utf8") return new TextEncoder().encode(content);
  if (row.encoding === "base64") return base64ToBytes(content);
  return Promise.race([
    resolveBlob(db, content),
    new Promise<null>((r) => setTimeout(() => r(null), SITE_BLOB_RESOLVE_TIMEOUT_MS)),
  ]);
}

/** Resolve a file to served bytes + content type. "" / trailing "/" → index.html. */
export async function getFileForServe(
  db: DbDriver,
  siteId: string,
  path: string,
): Promise<{ contentType: string; bytes: Uint8Array } | null> {
  const row = getFileRow(db, siteId, path);
  if (!row) return null;
  const bytes = await decodeFileRow(db, row);
  if (!bytes) return null;
  return { contentType: row.content_type, bytes };
}

/**
 * HTTP-serve metadata for one request path: the resolved row (index.html /
 * 404.html rules from resolveSiteFileRow), its serve status, and a weak ETag —
 * WITHOUT decoding content. The ETag comes from what the register already
 * holds, so an If-None-Match hit can 304 before resolveBlob's (worst-case 5s)
 * peer/bucket fan-out ever runs:
 *   - blob rows: the content field IS the content hash — use it directly;
 *   - utf8/base64 rows: Bun.hash over encoding + content (the encoding prefix
 *     keeps a text file and a base64 file with equal stored strings distinct).
 * Weak (W/) because the same content may be re-encoded across
 * representations, and we never serve byte-range requests off it.
 */
export function getFileMetaForServe(
  db: DbDriver,
  siteId: string,
  path: string,
  opts: { spa?: boolean } = {},
): {
  row: Pick<SiteFileRow, "content_type" | "encoding" | "content">;
  status: 200 | 404;
  etag: string;
} | null {
  const hit = resolveSiteFileRow(db, siteId, path, opts);
  if (!hit) return null;
  // content_type is part of the validator: the same bytes re-served under a
  // corrected content-type must mint a fresh ETag, else a client that cached the
  // old representation stays on the wrong type through a 304.
  const ct = hit.row.content_type ?? "";
  const etag =
    hit.row.encoding === "blob"
      ? `W/"${hit.row.content ?? ""}-${Bun.hash(ct).toString(16)}"`
      : `W/"${Bun.hash(`${ct}:${hit.row.encoding}:${hit.row.content ?? ""}`).toString(16)}"`;
  return { ...hit, etag };
}

/**
 * Cache-Control for a served site file. Everything is `private` today (every
 * caller passes isPublic=false — served pages sit behind the master token or a
 * capability slug, neither of which may enter a shared cache); the isPublic
 * branch is pre-wired for Batch 4's visibility:public sites, where a CDN /
 * reverse proxy may cache.
 *   - HTML: no-cache — always revalidate (ETag/304) so a republish shows up on
 *     the next navigation;
 *   - inline text assets (css/js/json…): short TTL + stale-while-revalidate;
 *   - blob assets: content-addressed and big — cache a while.
 */
export function siteCacheControl(
  contentType: string,
  encoding: FileEncoding,
  isPublic: boolean,
): string {
  const vis = isPublic ? "public" : "private";
  if (contentType.toLowerCase().includes("text/html")) return `${vis}, no-cache`;
  // Public blobs get the SAME short freshness as text assets (not 1h): a site
  // flipped back to private has no way to purge a shared/CDN cache, so a long
  // max-age would keep the bytes reachable for up to an hour after. Private
  // blobs (behind the token / capability slug) can't be shared-cached, so they
  // keep the cheaper 1h TTL.
  if (encoding === "blob")
    return isPublic ? `public, max-age=300, stale-while-revalidate=3600` : `private, max-age=3600`;
  return `${vis}, max-age=300, stale-while-revalidate=3600`;
}
