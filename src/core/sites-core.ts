// Portable (driver-only) half of the sites feature: types, name/path
// canonicalization, MIME inference, and read paths. Split from sites.ts so the
// browser replica's worker can serve site files offline without pulling the
// blob store (cache.ts → node:fs) into a browser bundle. sites.ts re-exports
// everything here — server-side callers keep importing from sites.ts.

import type { DbDriver } from "./driver.ts";
import { MhError } from "./errors.ts";
import { emit, grouped, withChangeGroup } from "./crdt.ts";
import { newId } from "./ids.ts";
import type { ColumnsOf } from "./sqlcols.ts";
import { serializeGrantSet, validateGrantSetInput, type GrantSet } from "./grants-core.ts";

export interface SiteRow {
  id: string;
  name: string;
  title: string | null;
  created_hlc: string;
  /** Access register: exactly "public" = served without a token. Synced, so a
   *  peer can write ANY string here — never read it directly, go through
   *  isSitePublic (default-deny). */
  visibility: string | null;
  /** 1 = SPA fallback: extension-less misses serve index.html (status 200). */
  spa: number;
  /** Serialized GrantSet for the anonymous /sites/<name>/api/* surface. Synced
   *  register — never read raw, always through parseGrantSet (default-deny). */
  public_grants: string | null;
}

export const SITE_COLS = ["id", "name", "title", "created_hlc", "visibility", "spa", "public_grants"] as const;
const _siteCols: ColumnsOf<SiteRow, typeof SITE_COLS> = SITE_COLS;
const SITE_SELECT = SITE_COLS.join(", ");

export type FileEncoding = "utf8" | "base64" | "blob";

export interface SiteFileRow {
  id: string;
  site_id: string;
  path: string;
  content_type: string;
  encoding: FileEncoding;
  /** Inline text/base64, or a blob hash when encoding === "blob". */
  content: string | null;
}

/** Manifest entry — file metadata without the (potentially large) content.
 *  `size` is derived at query time (see listFiles), never stored. */
export type SiteFileSummary = Omit<SiteFileRow, "content"> & {
  /** Served byte size: exact for utf8, ~exact for base64 (padding ignored),
   *  blob_cache lookup for blobs — null when the blob bytes aren't held
   *  locally (e.g. a browser replica, or an evicted cache entry). */
  size: number | null;
};

export const SITE_FILE_COLS = [
  "id", "site_id", "path", "content_type", "encoding", "content",
] as const;
const _siteFileCols: ColumnsOf<SiteFileRow, typeof SITE_FILE_COLS> = SITE_FILE_COLS;
export const SITE_FILE_SELECT = SITE_FILE_COLS.join(", ");

// ---- mime / encoding helpers -----------------------------------------------

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  webmanifest: "application/manifest+json",
  ico: "image/x-icon",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  wasm: "application/wasm",
  // Audio / video: doc media blocks serve from /blob/<hash>.<ext>, so the byte
  // route needs a correct type for <video>/<audio> to play (esp. Safari, which
  // refuses octet-stream). Keep in sync with blocks.ts VIDEO_EXTS / AUDIO_EXTS.
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/opus",
  weba: "audio/webm",
  // Common attachment types so a downloaded file keeps a sensible type.
  csv: "text/csv; charset=utf-8",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Guess a content type from a file path's extension; default octet-stream. */
export function inferContentType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

// ---- name / path normalization ---------------------------------------------

/**
 * Canonical site slug: lowercase, [a-z0-9-] only, no leading/trailing/repeated
 * dashes. Applied at every write and lookup so the served URL (/sites/<name>/),
 * duplicate detection, and sync replication all agree on one form regardless of
 * how the name was typed (CLI, API, or browser). Throws when nothing usable
 * remains (empty, or all-punctuation). Matches the WebUI's slugify exactly.
 */
export function normalizeSiteName(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new MhError("invalid_input", `invalid site name: ${JSON.stringify(raw)}`);
  return slug;
}

/**
 * Canonical in-site file path: drop empty / "." segments, resolve ".." within
 * the bucket, strip leading and duplicate slashes. Files live in SQLite keyed by
 * this exact string (there is no filesystem behind them), so normalizing at the
 * write/serve boundary keeps storage, URL routing, and deletes consistent no
 * matter how the path was typed or percent-encoded. May return "" (caller decides).
 */
export function normalizeSitePath(raw: string): string {
  const segs: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") segs.pop();
    else segs.push(seg);
  }
  return segs.join("/");
}

// ---- read paths --------------------------------------------------------------

/**
 * THE public/private decision point — every serve surface must route through
 * here (default-deny). `visibility` is a synced CRDT register: any peer
 * (including a malicious or future-versioned one) can write arbitrary strings
 * into it, so only the exact string "public" opens the site; "PUBLIC", "true",
 * garbage, and NULL all mean private.
 */
export function isSitePublic(site: Pick<SiteRow, "visibility">): boolean {
  return site.visibility === "public";
}

export function getSite(db: DbDriver, id: string): SiteRow | null {
  return db
    .query(`SELECT ${SITE_SELECT} FROM sites WHERE id = ? AND __deleted = 0`)
    .get(id) as SiteRow | null;
}

/** Most recently created live site with this name (URL routing). */
export function getSiteByName(db: DbDriver, name: string): SiteRow | null {
  // Normalize so lookups, dedup, and URL routing all key off the canonical slug
  // (e.g. "Demo" and "demo" collide). An unusable name simply matches nothing.
  let slug: string;
  try {
    slug = normalizeSiteName(name);
  } catch {
    return null;
  }
  return db
    .query(
      `SELECT ${SITE_SELECT} FROM sites WHERE name = ? AND __deleted = 0 ORDER BY created_hlc DESC LIMIT 1`,
    )
    .get(slug) as SiteRow | null;
}

export function listSites(db: DbDriver): SiteRow[] {
  return db
    .query(`SELECT ${SITE_SELECT} FROM sites WHERE __deleted = 0 ORDER BY created_hlc`)
    .all() as SiteRow[];
}

/** Resolve a site ref (`site_…` id or name) to its row, or throw. */
export function resolveSite(db: DbDriver, ref: string): SiteRow {
  const byId = ref.startsWith("site_") ? getSite(db, ref) : null;
  const site = byId ?? getSiteByName(db, ref);
  if (!site) throw new MhError("not_found", `no such site: ${ref}`);
  return site;
}

/**
 * Portable half of file serving: canonical path resolution ("" / trailing "/"
 * → index.html, same normalization putFile stored under) + the raw row. Used
 * directly by the browser replica's worker, which must decode utf8/base64
 * itself and cannot reach "blob" content at all (blob bytes live in the
 * server's on-disk store, not the oplog — they don't replicate).
 */
export function getFileRow(
  db: DbDriver,
  siteId: string,
  path: string,
): { content_type: string; encoding: FileEncoding; content: string | null } | null {
  // Resolve directory-style requests to index.html *before* normalizing (the
  // trailing-slash signal is lost once empty segments are dropped).
  const withIndex = path === "" || path.endsWith("/") ? `${path}index.html` : path;
  const p = normalizeSitePath(withIndex);
  if (!p) return null;
  return fileRowAtPath(db, siteId, p);
}

/** The raw live-row lookup by an already-canonical path (no index resolution). */
function fileRowAtPath(
  db: DbDriver,
  siteId: string,
  p: string,
): Pick<SiteFileRow, "content_type" | "encoding" | "content"> | null {
  return db
    .query(
      "SELECT content_type, encoding, content FROM site_files WHERE site_id = ? AND path = ? AND __deleted = 0 ORDER BY created_hlc LIMIT 1",
    )
    .get(siteId, p) as Pick<SiteFileRow, "content_type" | "encoding" | "content"> | null;
}

/**
 * Resolve a request path to the row that should be served, GitHub-Pages style:
 * "" / trailing "/" → index.html (same order as getFileRow: index resolution
 * first, then normalization); a miss falls back to the site's own `404.html`
 * (served with status 404) when it exists; a pure miss returns null (caller
 * renders its built-in 404). Shared by every serve surface — server, share,
 * browser replica (db-worker siteFile op), and the service worker — so online
 * and offline 404 behavior stay identical.
 *
 * `opts.spa` (the sites.spa column): a miss on a path whose last segment has no
 * extension falls back to index.html with status 200 — client-side routes like
 * /sites/app/settings/profile render the app shell, while a missing asset
 * (app.js, logo.png) still 404s honestly instead of serving HTML to a <script>.
 * The SPA fallback runs before the 404.html fallback.
 */
export function resolveSiteFileRow(
  db: DbDriver,
  siteId: string,
  path: string,
  opts: { spa?: boolean } = {},
): { row: Pick<SiteFileRow, "content_type" | "encoding" | "content">; status: 200 | 404 } | null {
  const withIndex = path === "" || path.endsWith("/") ? `${path}index.html` : path;
  const p = normalizeSitePath(withIndex);
  if (p) {
    const row = fileRowAtPath(db, siteId, p);
    if (row) return { row, status: 200 };
  }
  if (opts.spa) {
    // Extension test on the REQUEST path's last segment (not the index-resolved
    // one): "app/" and "app" are routes, "app.js" is an asset.
    const last = path.split("/").pop() ?? "";
    if (!/\.[a-z0-9]+$/i.test(last)) {
      const idx = fileRowAtPath(db, siteId, "index.html");
      if (idx) return { row: idx, status: 200 };
    }
  }
  const nf = fileRowAtPath(db, siteId, "404.html");
  if (nf) return { row: nf, status: 404 };
  return null;
}

export function listFiles(db: DbDriver, siteId: string): SiteFileSummary[] {
  // size derives from what each row already stores — no schema column:
  //   utf8   → byte length of the text (CAST AS BLOB counts bytes, not chars);
  //   base64 → decoded size approximated as 3/4 of the encoded length
  //            (padding not subtracted — off by ≤2 bytes, fine for display);
  //   blob   → content IS the hash; blob_cache holds the true size when the
  //            bytes are held locally, else NULL (callers render "—").
  return db
    .query(
      `SELECT id, site_id, path, content_type, encoding,
         CASE encoding
           WHEN 'utf8' THEN LENGTH(CAST(content AS BLOB))
           WHEN 'base64' THEN (LENGTH(content) / 4) * 3
           ELSE (SELECT size FROM blob_cache WHERE hash = content)
         END AS size
       FROM site_files WHERE site_id = ? AND __deleted = 0 ORDER BY path`,
    )
    .all(siteId) as SiteFileSummary[];
}

/** The listFiles size derivation for one already-loaded row (the upload route
 *  returns the row it just wrote and must report the same size the manifest
 *  will). Kept in lockstep with the SQL CASE above. */
export function fileSizeOf(
  db: DbDriver,
  row: Pick<SiteFileRow, "encoding" | "content">,
): number | null {
  const content = row.content ?? "";
  if (row.encoding === "utf8") return new TextEncoder().encode(content).byteLength;
  if (row.encoding === "base64") return Math.floor(content.length / 4) * 3;
  const hit = db.query("SELECT size FROM blob_cache WHERE hash = ?").get(content) as {
    size: number;
  } | null;
  return hit?.size ?? null;
}

// ---- portable mutations -----------------------------------------------------
// All write through emit() so sites replicate over the oplog. These are
// driver-only (no node:fs / blob store), so the browser replica can author
// sites offline too — large-binary blob storage is the one server-only piece
// (see putFile in sites.ts).

/** Binaries at or below this size store inline (base64); larger need a blob. */
export const INLINE_LIMIT = 256 * 1024;

/** Text-ish types store as readable utf8; everything else is binary. */
export function isTextType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith("text/") ||
    ct.startsWith("application/json") ||
    ct.startsWith("application/manifest+json") ||
    ct.startsWith("application/xml") ||
    ct.startsWith("application/javascript") ||
    ct.startsWith("image/svg+xml")
  );
}

/** Raster image types (svg is text, handled by isTextType). These always store
 *  as a content-addressed blob regardless of size — they never base64-inline
 *  into the oplog, keeping replicas lean. */
export function isImageType(contentType: string): boolean {
  return contentType.toLowerCase().startsWith("image/") && !isTextType(contentType);
}

export function toBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** Portable base64 (no Buffer): for inline small-binary file content. */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

/** Portable base64 decode (no Buffer) — inverse of bytesToBase64. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Local writes only accept the two canonical values (a peer can still sync
 *  arbitrary strings — isSitePublic default-denies those on read). */
function assertVisibility(v: string): asserts v is "public" | "private" {
  if (v !== "public" && v !== "private")
    throw new MhError("invalid_input", `visibility must be "public" or "private", got ${JSON.stringify(v)}`);
}

export const createSite = grouped(function createSite(
  db: DbDriver,
  opts: { name: string; title?: string; visibility?: "public" | "private" },
): SiteRow {
  const name = normalizeSiteName(opts.name);
  if (getSiteByName(db, name)) throw new MhError("conflict", `site name already exists: ${name}`);
  if (opts.visibility !== undefined) assertVisibility(opts.visibility);
  const id = newId("site", name);
  const first = emit(db, "sites", id, "name", name);
  emit(db, "sites", id, "created_hlc", first.hlc);
  if (opts.title !== undefined) emit(db, "sites", id, "title", opts.title);
  if (opts.visibility !== undefined) emit(db, "sites", id, "visibility", opts.visibility);
  return getSite(db, id)!;
});

/** Rename a site, change its title, and/or set visibility / SPA mode.
 *  Guards against duplicate names; visibility only accepts public|private. */
export const updateSite = grouped(function updateSite(
  db: DbDriver,
  id: string,
  opts: { name?: string; title?: string; visibility?: "public" | "private"; spa?: boolean },
): SiteRow {
  if (!getSite(db, id)) throw new MhError("not_found", `no such site: ${id}`);
  if (opts.visibility !== undefined) assertVisibility(opts.visibility);
  if (opts.name !== undefined) {
    const name = normalizeSiteName(opts.name);
    const dup = getSiteByName(db, name);
    if (dup && dup.id !== id) throw new MhError("conflict", `site name already exists: ${name}`);
    emit(db, "sites", id, "name", name);
  }
  if (opts.title !== undefined) emit(db, "sites", id, "title", opts.title);
  if (opts.visibility !== undefined) emit(db, "sites", id, "visibility", opts.visibility);
  if (opts.spa !== undefined) emit(db, "sites", id, "spa", opts.spa ? 1 : 0);
  return getSite(db, id)!;
});

/**
 * Set (or clear, with null) a site's public data grants. The set is validated
 * loudly here (this is the LOCAL write path — a peer can still sync junk, which
 * readers default-deny via parseGrantSet) and stored in canonical serialized
 * form. Grants only take effect while the site is visibility:public; setting
 * them on a private site is allowed (they arm when the site goes public).
 */
export const setSitePublicGrants = grouped(function setSitePublicGrants(
  db: DbDriver,
  siteId: string,
  grants: GrantSet | null,
): SiteRow {
  if (!getSite(db, siteId)) throw new MhError("not_found", `no such site: ${siteId}`);
  const value = grants == null ? null : serializeGrantSet(validateGrantSetInput(grants));
  emit(db, "sites", siteId, "public_grants", value);
  return getSite(db, siteId)!;
});

export const deleteSite = grouped(function deleteSite(db: DbDriver, id: string): boolean {
  if (!getSite(db, id)) return false;
  const files = db
    .query("SELECT id FROM site_files WHERE site_id = ? AND __deleted = 0")
    .all(id) as { id: string }[];
  for (const f of files) emit(db, "site_files", f.id, "__deleted", 1);
  emit(db, "sites", id, "__deleted", 1);
  return true;
});

/** Stable id for a (site, path) pair so re-uploads merge instead of duplicate. */
export function fileIdFor(db: DbDriver, siteId: string, path: string): string | null {
  const row = db
    .query("SELECT id FROM site_files WHERE site_id = ? AND path = ? ORDER BY created_hlc LIMIT 1")
    .get(siteId, path) as { id: string } | null;
  return row?.id ?? null;
}

/**
 * The live row at (site, path) when it already stores exactly this
 * content_type/encoding/content triple — the skip-unchanged probe. Tombstoned
 * rows never match (re-uploading the same bytes must still un-delete). putFile's
 * blob branch also calls this with the content hash *before* touching the blob
 * store, so an unchanged re-publish never re-marks a flushed blob as pending.
 */
export function liveFileRowIfSame(
  db: DbDriver,
  siteId: string,
  cleanPath: string,
  contentType: string,
  encoding: FileEncoding,
  content: string,
): SiteFileRow | null {
  const row = db
    .query(
      `SELECT ${SITE_FILE_SELECT} FROM site_files WHERE site_id = ? AND path = ? AND __deleted = 0 ORDER BY created_hlc LIMIT 1`,
    )
    .get(siteId, cleanPath) as SiteFileRow | null;
  if (!row) return null;
  return row.content_type === contentType && row.encoding === encoding && row.content === content
    ? row
    : null;
}

/** Emit the register writes for one file (shared by inline + blob put paths).
 *  Skip-unchanged: when a live row already stores exactly this triple, nothing
 *  is emitted and the row returns with `changed: false` — an idempotent
 *  re-publish adds zero oplog rows on every peer. A tombstoned row always
 *  rewrites (`changed: true`) so same-byte re-uploads still un-delete. */
export function writeFileRow(
  db: DbDriver,
  siteId: string,
  cleanPath: string,
  contentType: string,
  encoding: FileEncoding,
  content: string,
): SiteFileRow & { changed: boolean } {
  const same = liveFileRowIfSame(db, siteId, cleanPath, contentType, encoding, content);
  if (same) return { ...same, changed: false };
  const existing = fileIdFor(db, siteId, cleanPath);
  const id = existing ?? newId("sf", cleanPath);
  withChangeGroup(null, () => {
    if (!existing) {
      const first = emit(db, "site_files", id, "site_id", siteId);
      emit(db, "site_files", id, "path", cleanPath);
      emit(db, "site_files", id, "created_hlc", first.hlc);
    }
    emit(db, "site_files", id, "content_type", contentType);
    emit(db, "site_files", id, "encoding", encoding);
    emit(db, "site_files", id, "content", content);
    emit(db, "site_files", id, "__deleted", 0); // un-delete on re-upload
  });
  const row = db
    .query(`SELECT ${SITE_FILE_SELECT} FROM site_files WHERE id = ?`)
    .get(id) as SiteFileRow;
  return { ...row, changed: true };
}

/**
 * Upload/replace one file inline (utf8 text or small base64 binary) — portable,
 * so the browser replica authors sites offline. Binaries over INLINE_LIMIT need
 * the server-only blob store; here they throw (sites.ts putFile handles them).
 */
export function putFileInline(
  db: DbDriver,
  siteId: string,
  path: string,
  opts: { data: string | Uint8Array | ArrayBuffer; contentType?: string },
): SiteFileRow & { changed: boolean } {
  const cleanPath = normalizeSitePath(path);
  if (!cleanPath) throw new MhError("invalid_input", `invalid file path: ${JSON.stringify(path)}`);
  const contentType = opts.contentType ?? inferContentType(cleanPath);
  let encoding: FileEncoding;
  let content: string;
  if (isTextType(contentType)) {
    encoding = "utf8";
    content = typeof opts.data === "string" ? opts.data : new TextDecoder().decode(toBytes(opts.data));
  } else {
    const bytes = toBytes(opts.data);
    if (bytes.byteLength > INLINE_LIMIT)
      throw new MhError(
        "invalid_input",
        "binary too large for inline storage (needs a server-backed blob)",
      );
    encoding = "base64";
    content = bytesToBase64(bytes);
  }
  return writeFileRow(db, siteId, cleanPath, contentType, encoding, content);
}

export const deleteFile = grouped(function deleteFile(
  db: DbDriver,
  siteId: string,
  path: string,
): boolean {
  const id = fileIdFor(db, siteId, normalizeSitePath(path));
  if (!id) return false;
  const live = db.query("SELECT __deleted AS d FROM site_files WHERE id = ?").get(id) as {
    d: number;
  } | null;
  if (!live || live.d) return false;
  emit(db, "site_files", id, "__deleted", 1);
  return true;
});

/** Live-file counts for ALL sites in one GROUP BY (walks idx_site_files_site) —
 *  the site list uses this instead of a per-site fileCount N+1. Sites with no
 *  live files have no entry; callers default to 0. */
export function fileCounts(db: DbDriver): Map<string, number> {
  const rows = db
    .query("SELECT site_id, COUNT(*) AS n FROM site_files WHERE __deleted = 0 GROUP BY site_id")
    .all() as { site_id: string; n: number }[];
  return new Map(rows.map((r) => [r.site_id, r.n]));
}

/** Count of live files per site (for the management list's file_count). */
export function fileCount(db: DbDriver, siteId: string): number {
  return (
    db
      .query("SELECT COUNT(*) AS n FROM site_files WHERE site_id = ? AND __deleted = 0")
      .get(siteId) as { n: number }
  ).n;
}
