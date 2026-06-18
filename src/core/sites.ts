import type { DbDriver } from "./driver.ts";
import { putBlob } from "./cache.ts";
import { MhError } from "./errors.ts";
import {
  type SiteFileRow,
  INLINE_LIMIT,
  inferContentType,
  normalizeSitePath,
  isTextType,
  isImageType,
  toBytes,
  writeFileRow,
  putFileInline,
  getFileRow,
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

/** Upload or replace one file. utf8 text and small binaries ride the oplog via
 *  putFileInline (portable); binaries over the inline limit offload to the
 *  node-local blob store (server-only — their bytes don't replicate). */
export async function putFile(
  db: DbDriver,
  siteId: string,
  path: string,
  opts: { data: string | Uint8Array | ArrayBuffer; contentType?: string },
): Promise<SiteFileRow> {
  const cleanPath = normalizeSitePath(path);
  if (!cleanPath) throw new MhError("invalid_input", `invalid file path: ${JSON.stringify(path)}`);
  const contentType = opts.contentType ?? inferContentType(cleanPath);
  if (!isTextType(contentType)) {
    const bytes = toBytes(opts.data);
    // Images always offload to a blob (never base64-inline); other binaries only
    // once they exceed the inline limit.
    if (isImageType(contentType) || bytes.byteLength > INLINE_LIMIT) {
      const info = await putBlob(bytes);
      recordBlob(db, info.hash, info.size, contentType); // produced here → pending=1
      return writeFileRow(db, siteId, cleanPath, contentType, "blob", info.hash);
    }
  }
  return putFileInline(db, siteId, cleanPath, opts);
}

/** Upper bound on remote blob resolution from the site-serve path. A miss fans
 *  out to every peer + bucket; without a cap a slow/unreachable source would hang
 *  the (token-gated) /sites/<name>/<asset> request. On timeout we 404 — the local
 *  cache hit is still instant (resolveBlob is local-first), so this only bounds
 *  the self-heal-from-remote tail. */
const SITE_BLOB_RESOLVE_TIMEOUT_MS = 5_000;

/** Resolve a file to served bytes + content type. "" / trailing "/" → index.html. */
export async function getFileForServe(
  db: DbDriver,
  siteId: string,
  path: string,
): Promise<{ contentType: string; bytes: Uint8Array } | null> {
  const row = getFileRow(db, siteId, path);
  if (!row) return null;

  const content = row.content ?? "";
  let bytes: Uint8Array | null;
  if (row.encoding === "utf8") bytes = new TextEncoder().encode(content);
  else if (row.encoding === "base64") bytes = new Uint8Array(Buffer.from(content, "base64"));
  else {
    // blob hash — resolve on demand (local cache → HTTP peer → bucket) so a
    // published asset whose local bytes were cache-evicted still serves from a
    // bucket/peer instead of 404ing, consistent with /blob. resolveBlob touches
    // the LRU on a local hit and caches any remote fetch. Bounded so a slow source
    // can't hang the serve path (404 on timeout; an in-flight fetch still finishes
    // and populates the cache for the next request).
    bytes = await Promise.race([
      resolveBlob(db, content),
      new Promise<null>((r) => setTimeout(() => r(null), SITE_BLOB_RESOLVE_TIMEOUT_MS)),
    ]);
  }
  if (!bytes) return null;

  return { contentType: row.content_type, bytes };
}
