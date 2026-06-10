import type { DbDriver } from "./driver.ts";
import { newId } from "./ids.ts";
import { emit, grouped, withChangeGroup } from "./crdt.ts";
import { putBlob, getBlob } from "./cache.ts";
import { MhError } from "./errors.ts";

// A "site" is a named bucket of files (Supabase-Storage-style) served at
// /sites/<name>/. Everything is written through emit() so sites replicate over
// /sync like records and documents. File bytes are stored inline as utf8 (text)
// or base64 (small binaries) so they ride the oplog; large binaries offload to
// the content-addressed cache (encoding="blob"), whose bytes are node-local.

export interface SiteRow {
  id: string;
  name: string;
  title: string | null;
  created_hlc: string;
}

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

/** Binaries at or below this size are stored inline (base64); larger go to a blob. */
const INLINE_LIMIT = 256 * 1024;

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

/** Text-ish types are stored as readable utf8; everything else is binary. */
function isTextType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith("text/") ||
    ct.startsWith("application/json") ||
    ct.startsWith("application/manifest+json") ||
    ct.startsWith("application/xml") ||
    ct.startsWith("text/javascript") ||
    ct.startsWith("application/javascript") ||
    ct.startsWith("image/svg+xml")
  );
}

function toBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

// ---- sites -----------------------------------------------------------------

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

export function getSite(db: DbDriver, id: string): SiteRow | null {
  return db
    .query("SELECT id, name, title, created_hlc FROM sites WHERE id = ? AND __deleted = 0")
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
      "SELECT id, name, title, created_hlc FROM sites WHERE name = ? AND __deleted = 0 ORDER BY created_hlc DESC LIMIT 1",
    )
    .get(slug) as SiteRow | null;
}

export function listSites(db: DbDriver): SiteRow[] {
  return db
    .query("SELECT id, name, title, created_hlc FROM sites WHERE __deleted = 0 ORDER BY created_hlc")
    .all() as SiteRow[];
}

/** Resolve a site ref (`site_…` id or name) to its row, or throw. */
export function resolveSite(db: DbDriver, ref: string): SiteRow {
  const byId = ref.startsWith("site_") ? getSite(db, ref) : null;
  const site = byId ?? getSiteByName(db, ref);
  if (!site) throw new MhError("not_found", `no such site: ${ref}`);
  return site;
}

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

// ---- files -----------------------------------------------------------------

/** Stable id for a (site, path) pair so re-uploads merge instead of duplicate. */
function fileIdFor(db: DbDriver, siteId: string, path: string): string | null {
  const row = db
    .query("SELECT id FROM site_files WHERE site_id = ? AND path = ? ORDER BY created_hlc LIMIT 1")
    .get(siteId, path) as { id: string } | null;
  return row?.id ?? null;
}

/** Upload or replace one file. Picks utf8 / base64 / blob storage automatically. */
export async function putFile(
  db: DbDriver,
  siteId: string,
  path: string,
  opts: { data: string | Uint8Array | ArrayBuffer; contentType?: string },
): Promise<SiteFileRow> {
  const cleanPath = normalizeSitePath(path);
  if (!cleanPath) throw new MhError("invalid_input", `invalid file path: ${JSON.stringify(path)}`);
  const contentType = opts.contentType ?? inferContentType(cleanPath);
  const bytes = toBytes(opts.data);

  let encoding: FileEncoding;
  let content: string;
  if (isTextType(contentType)) {
    encoding = "utf8";
    content = typeof opts.data === "string" ? opts.data : new TextDecoder().decode(bytes);
  } else if (bytes.byteLength <= INLINE_LIMIT) {
    encoding = "base64";
    content = Buffer.from(bytes).toString("base64");
  } else {
    encoding = "blob";
    content = (await putBlob(bytes)).hash;
  }

  // The emit tail is synchronous — group it here rather than wrapping the whole
  // async function (an outer group would be reset before post-await emits run).
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

  return db
    .query(
      "SELECT id, site_id, path, content_type, encoding, content FROM site_files WHERE id = ?",
    )
    .get(id) as SiteFileRow;
}

export function listFiles(db: DbDriver, siteId: string): SiteFileSummary[] {
  return db
    .query(
      "SELECT id, site_id, path, content_type, encoding FROM site_files WHERE site_id = ? AND __deleted = 0 ORDER BY path",
    )
    .all(siteId) as SiteFileSummary[];
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

/** Resolve a file to served bytes + content type. "" / trailing "/" → index.html. */
export async function getFileForServe(
  db: DbDriver,
  siteId: string,
  path: string,
): Promise<{ contentType: string; bytes: Uint8Array } | null> {
  // Resolve directory-style requests to index.html *before* normalizing (the
  // trailing-slash signal is lost once empty segments are dropped), then key the
  // lookup off the same canonical path putFile stored.
  const withIndex = path === "" || path.endsWith("/") ? `${path}index.html` : path;
  const p = normalizeSitePath(withIndex);
  if (!p) return null;
  const row = db
    .query(
      "SELECT content_type, encoding, content FROM site_files WHERE site_id = ? AND path = ? AND __deleted = 0 ORDER BY created_hlc LIMIT 1",
    )
    .get(siteId, p) as { content_type: string; encoding: FileEncoding; content: string | null } | null;
  if (!row) return null;

  const content = row.content ?? "";
  let bytes: Uint8Array | null;
  if (row.encoding === "utf8") bytes = new TextEncoder().encode(content);
  else if (row.encoding === "base64") bytes = new Uint8Array(Buffer.from(content, "base64"));
  else bytes = await getBlob(content); // blob hash
  if (!bytes) return null;

  return { contentType: row.content_type, bytes };
}
