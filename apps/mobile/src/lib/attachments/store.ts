import type { DbDriver } from "../../../../../src/core/driver";

export interface AttachmentEntry {
  src: string; hash: string; name: string; mime: string; uri: string;
  size: number; pending: number; pinned: number; error: string | null;
}
/** Native-only metadata. Pending bytes remain pinned until transport succeeds;
 * downloaded bytes are retained for offline use and never enter the CRDT log. */
export function createAttachmentStore(db: DbDriver) {
  db.exec(`CREATE TABLE IF NOT EXISTS mobile_attachments (
    src TEXT PRIMARY KEY, hash TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
    uri TEXT NOT NULL, size INTEGER NOT NULL, pending INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 1, error TEXT, updated_at INTEGER NOT NULL
  )`);
  return {
    get(src: string): AttachmentEntry | null {
      return db.query("SELECT * FROM mobile_attachments WHERE src = ?").get(src) as AttachmentEntry | null;
    },
    put(entry: AttachmentEntry) {
      db.query(`INSERT INTO mobile_attachments (src, hash, name, mime, uri, size, pending, pinned, error, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(src) DO UPDATE SET
        name=excluded.name, mime=excluded.mime, uri=excluded.uri, size=excluded.size,
        pending=MAX(mobile_attachments.pending, excluded.pending), pinned=MAX(mobile_attachments.pinned, excluded.pinned),
        error=excluded.error, updated_at=excluded.updated_at`)
        .run(entry.src, entry.hash, entry.name, entry.mime, entry.uri, entry.size, entry.pending, entry.pinned, entry.error, Date.now());
    },
    list(): AttachmentEntry[] { return db.query("SELECT * FROM mobile_attachments").all() as AttachmentEntry[]; },
    removeDownloaded(src: string) { db.query("DELETE FROM mobile_attachments WHERE src = ? AND pending = 0").run(src); },
    pending(): AttachmentEntry[] {
      return db.query("SELECT * FROM mobile_attachments WHERE pending = 1 ORDER BY updated_at").all() as AttachmentEntry[];
    },
    uploaded(src: string) {
      db.query("UPDATE mobile_attachments SET pending = 0, error = NULL, updated_at = ? WHERE src = ?").run(Date.now(), src);
    },
    failed(src: string, error: string) {
      db.query("UPDATE mobile_attachments SET error = ?, updated_at = ? WHERE src = ?").run(error, Date.now(), src);
    },
  };
}
export function parseBlobSource(src: string): { hash: string; extension: string } {
  const match = /^\/blob\/([a-f0-9]{16,64})(?:\.([a-z0-9]{1,12}))?$/.exec(src);
  if (!match) throw new Error("无效的附件引用");
  return { hash: match[1]!, extension: match[2] ?? "" };
}
export function attachmentType(mime: string, name: string): { mime: string; extension: string } {
  const types: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/heic": "heic", "image/svg+xml": "svg",
    "application/pdf": "pdf", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/ogg": "ogv", "video/x-matroska": "mkv",
    "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac", "audio/opus": "opus", "audio/webm": "weba",
  };
  const extension = types[mime] ?? (/\.([a-z0-9]{1,12})$/i.exec(name)?.[1]?.toLowerCase() ?? "");
  const inferred = Object.entries(types).find(([, ext]) => ext === extension)?.[0];
  // SVG can run active content in external viewers; still store faithfully.
  return { mime: mime === "application/octet-stream" ? inferred ?? mime : mime, extension };
}
