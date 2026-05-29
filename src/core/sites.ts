import type { Database } from "bun:sqlite";
import { newId } from "./ids.ts";
import { emit } from "./crdt.ts";
import { putBlob, getBlob } from "./cache.ts";

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

export function createSite(db: Database, opts: { name: string; title?: string }): SiteRow {
  if (getSiteByName(db, opts.name)) throw new Error(`site name already exists: ${opts.name}`);
  const id = newId("site", opts.name);
  const first = emit(db, "sites", id, "name", opts.name);
  emit(db, "sites", id, "created_hlc", first.hlc);
  if (opts.title !== undefined) emit(db, "sites", id, "title", opts.title);
  return getSite(db, id)!;
}

export function getSite(db: Database, id: string): SiteRow | null {
  return db
    .query("SELECT id, name, title, created_hlc FROM sites WHERE id = ? AND __deleted = 0")
    .get(id) as SiteRow | null;
}

/** Most recently created live site with this name (URL routing). */
export function getSiteByName(db: Database, name: string): SiteRow | null {
  return db
    .query(
      "SELECT id, name, title, created_hlc FROM sites WHERE name = ? AND __deleted = 0 ORDER BY created_hlc DESC LIMIT 1",
    )
    .get(name) as SiteRow | null;
}

export function listSites(db: Database): SiteRow[] {
  return db
    .query("SELECT id, name, title, created_hlc FROM sites WHERE __deleted = 0 ORDER BY created_hlc")
    .all() as SiteRow[];
}

/** Resolve a site ref (`site_…` id or name) to its row, or throw. */
export function resolveSite(db: Database, ref: string): SiteRow {
  const byId = ref.startsWith("site_") ? getSite(db, ref) : null;
  const site = byId ?? getSiteByName(db, ref);
  if (!site) throw new Error(`no such site: ${ref}`);
  return site;
}

export function deleteSite(db: Database, id: string): boolean {
  if (!getSite(db, id)) return false;
  const files = db
    .query("SELECT id FROM site_files WHERE site_id = ? AND __deleted = 0")
    .all(id) as { id: string }[];
  for (const f of files) emit(db, "site_files", f.id, "__deleted", 1);
  emit(db, "sites", id, "__deleted", 1);
  return true;
}

// ---- files -----------------------------------------------------------------

/** Stable id for a (site, path) pair so re-uploads merge instead of duplicate. */
function fileIdFor(db: Database, siteId: string, path: string): string | null {
  const row = db
    .query("SELECT id FROM site_files WHERE site_id = ? AND path = ? ORDER BY created_hlc LIMIT 1")
    .get(siteId, path) as { id: string } | null;
  return row?.id ?? null;
}

/** Upload or replace one file. Picks utf8 / base64 / blob storage automatically. */
export async function putFile(
  db: Database,
  siteId: string,
  path: string,
  opts: { data: string | Uint8Array | ArrayBuffer; contentType?: string },
): Promise<SiteFileRow> {
  const contentType = opts.contentType ?? inferContentType(path);
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

  const existing = fileIdFor(db, siteId, path);
  const id = existing ?? newId("sf", path);
  if (!existing) {
    const first = emit(db, "site_files", id, "site_id", siteId);
    emit(db, "site_files", id, "path", path);
    emit(db, "site_files", id, "created_hlc", first.hlc);
  }
  emit(db, "site_files", id, "content_type", contentType);
  emit(db, "site_files", id, "encoding", encoding);
  emit(db, "site_files", id, "content", content);
  emit(db, "site_files", id, "__deleted", 0); // un-delete on re-upload

  return db
    .query(
      "SELECT id, site_id, path, content_type, encoding, content FROM site_files WHERE id = ?",
    )
    .get(id) as SiteFileRow;
}

export function listFiles(db: Database, siteId: string): SiteFileSummary[] {
  return db
    .query(
      "SELECT id, site_id, path, content_type, encoding FROM site_files WHERE site_id = ? AND __deleted = 0 ORDER BY path",
    )
    .all(siteId) as SiteFileSummary[];
}

export function deleteFile(db: Database, siteId: string, path: string): boolean {
  const id = fileIdFor(db, siteId, path);
  if (!id) return false;
  const live = db.query("SELECT __deleted AS d FROM site_files WHERE id = ?").get(id) as {
    d: number;
  } | null;
  if (!live || live.d) return false;
  emit(db, "site_files", id, "__deleted", 1);
  return true;
}

/** Resolve a file to served bytes + content type. "" / trailing "/" → index.html. */
export async function getFileForServe(
  db: Database,
  siteId: string,
  path: string,
): Promise<{ contentType: string; bytes: Uint8Array } | null> {
  const p = path === "" || path.endsWith("/") ? `${path}index.html` : path;
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
