// Portable (driver-only) half of the sites feature: types, name/path
// canonicalization, MIME inference, and read paths. Split from sites.ts so the
// browser replica's worker can serve site files offline without pulling the
// blob store (cache.ts → node:fs) into a browser bundle. sites.ts re-exports
// everything here — server-side callers keep importing from sites.ts.

import type { DbDriver } from "./driver.ts";
import { MhError } from "./errors.ts";
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
