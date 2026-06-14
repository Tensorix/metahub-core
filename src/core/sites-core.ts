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

export interface SiteRow {
  id: string;
  name: string;
  title: string | null;
  created_hlc: string;
}

export const SITE_COLS = ["id", "name", "title", "created_hlc"] as const;
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

/** Manifest entry — file metadata without the (potentially large) content. */
export type SiteFileSummary = Omit<SiteFileRow, "content">;

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
  return db
    .query(
      "SELECT content_type, encoding, content FROM site_files WHERE site_id = ? AND path = ? AND __deleted = 0 ORDER BY created_hlc LIMIT 1",
    )
    .get(siteId, p) as { content_type: string; encoding: FileEncoding; content: string | null } | null;
}

export function listFiles(db: DbDriver, siteId: string): SiteFileSummary[] {
  return db
    .query(
      "SELECT id, site_id, path, content_type, encoding FROM site_files WHERE site_id = ? AND __deleted = 0 ORDER BY path",
    )
    .all(siteId) as SiteFileSummary[];
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

export function toBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** Portable base64 (no Buffer): for inline small-binary file content. */
function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export const createSite = grouped(function createSite(
  db: DbDriver,
  opts: { name: string; title?: string },
): SiteRow {
  const name = normalizeSiteName(opts.name);
  if (getSiteByName(db, name)) throw new MhError("conflict", `site name already exists: ${name}`);
  const id = newId("site", name);
  const first = emit(db, "sites", id, "name", name);
  emit(db, "sites", id, "created_hlc", first.hlc);
  if (opts.title !== undefined) emit(db, "sites", id, "title", opts.title);
  return getSite(db, id)!;
});

/** Rename a site and/or change its title. Guards against duplicate names. */
export const updateSite = grouped(function updateSite(
  db: DbDriver,
  id: string,
  opts: { name?: string; title?: string },
): SiteRow {
  if (!getSite(db, id)) throw new MhError("not_found", `no such site: ${id}`);
  if (opts.name !== undefined) {
    const name = normalizeSiteName(opts.name);
    const dup = getSiteByName(db, name);
    if (dup && dup.id !== id) throw new MhError("conflict", `site name already exists: ${name}`);
    emit(db, "sites", id, "name", name);
  }
  if (opts.title !== undefined) emit(db, "sites", id, "title", opts.title);
  return getSite(db, id)!;
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

/** Emit the register writes for one file (shared by inline + blob put paths). */
export function writeFileRow(
  db: DbDriver,
  siteId: string,
  cleanPath: string,
  contentType: string,
  encoding: FileEncoding,
  content: string,
): SiteFileRow {
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
  return db.query(`SELECT ${SITE_FILE_SELECT} FROM site_files WHERE id = ?`).get(id) as SiteFileRow;
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
): SiteFileRow {
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

/** Count of live files per site (for the management list's file_count). */
export function fileCount(db: DbDriver, siteId: string): number {
  return (
    db
      .query("SELECT COUNT(*) AS n FROM site_files WHERE site_id = ? AND __deleted = 0")
      .get(siteId) as { n: number }
  ).n;
}
