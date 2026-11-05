import type { DbDriver } from "../../../../../src/core/driver";
import type { AttachmentManager } from "../attachments/native";
import { blobRefsIn } from "../../../../../src/core/blobs-core";

interface Ref {
  site_id: string;
  path: string;
  hash: string;
}
interface Verified {
  uri: string;
  size: number;
  modified: number | null;
}
function references(db: DbDriver, siteId?: string) {
  const sql =
    "SELECT f.site_id,f.path,f.content AS hash FROM site_files f JOIN sites s ON s.id=f.site_id WHERE f.__deleted=0 AND s.__deleted=0 AND f.encoding='blob' AND f.content IS NOT NULL";
  return (
    siteId
      ? db.query(sql + " AND f.site_id=?").all(siteId)
      : db.query(sql).all()
  ) as Ref[];
}

export function liveSiteHashes(db: DbDriver) {
  return new Set(references(db).map((ref) => ref.hash));
}
export function createSiteResources(
  db: DbDriver,
  attachments: Pick<AttachmentManager, "cache">,
  current: () => boolean,
  inspect: (uri: string) => {
    exists: boolean;
    size: number;
    modificationTime: number | null;
    delete(): void;
  },
) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS mobile_site_downloads(hash TEXT PRIMARY KEY)",
  );
  const files = new Map<string, Verified>();
  const errors = new Map<string, string>();
  const listeners = new Set<() => void>();
  let queued = false,
    version = 0;
  let running: Promise<void> | null = null;
  function emit() {
    version++;
    for (const fn of listeners) fn();
  }
  function cached(hash: string) {
    const entry = files.get(hash);
    if (!entry) return null;
    const file = inspect(entry.uri);
    return file.exists &&
      file.size === entry.size &&
      file.modificationTime === entry.modified
      ? entry.uri
      : null;
  }
  function missing(siteId: string) {
    const incomplete = db
      .query(
        "SELECT COALESCE(NULLIF(path,''),id) AS path FROM site_files WHERE site_id=? AND __deleted=0 AND (content IS NULL OR content_type IS NULL OR encoding IS NULL OR encoding NOT IN ('blob','utf8','base64'))",
      )
      .all(siteId) as { path: string }[];
    return references(db, siteId)
      .filter((ref) => !cached(ref.hash))
      .map((ref) => ({ path: ref.path, error: errors.get(ref.hash) }))
      .concat(
        incomplete.map((row) => ({
          path: row.path,
          error: "文件尚未同步完整",
        })),
      );
  }
  async function drain() {
    while (queued && current()) {
      queued = false;
      const hashes = liveSiteHashes(db);
      for (const hash of hashes) {
        if (!current()) return;
        if (cached(hash)) continue;
        try {
          const existing = db
            .query(
              "SELECT src FROM mobile_attachments WHERE hash=? ORDER BY pending DESC,pinned DESC LIMIT 1",
            )
            .get(hash) as { src: string } | null;
          const src = existing?.src ?? "/blob/" + hash;
          if (!/^[a-f0-9]{16,64}$/.test(hash))
            throw new Error("无效的资源哈希");
          if (!existing)
            db.query(
              "INSERT OR IGNORE INTO mobile_site_downloads(hash) VALUES(?)",
            ).run(hash);
          await attachments.cache(src);
          if (!current()) return;
          const entry = db
            .query("SELECT uri,size FROM mobile_attachments WHERE src=?")
            .get(src) as { uri: string; size: number };
          files.set(hash, {
            ...entry,
            modified: inspect(entry.uri).modificationTime,
          });
          errors.delete(hash);
        } catch (e) {
          if (!current()) return;
          files.delete(hash);
          errors.set(hash, e instanceof Error ? e.message : "资源准备失败");
        }
        emit();
      }
      if (!current()) return;
      const owned = db
        .query("SELECT hash FROM mobile_site_downloads")
        .all() as { hash: string }[];
      // A sync may add a reference while an earlier download is awaiting I/O.
      const live = liveSiteHashes(db);
      for (const hash of errors.keys())
        if (!live.has(hash)) errors.delete(hash);
      for (const hash of files.keys()) if (!live.has(hash)) files.delete(hash);
      const obsolete = owned.filter((row) => !live.has(row.hash));
      if (obsolete.length) {
        const retained = new Set<string>();
        const blocks = db
          .query(
            "SELECT text FROM doc_blocks WHERE __deleted=0 AND text LIKE '%/blob/%'",
          )
          .all() as { text: string }[];
        for (const row of blocks)
          for (const hash of blobRefsIn(row.text)) retained.add(hash);
        for (const { hash } of obsolete) {
          if (retained.has(hash)) continue;
          const src = "/blob/" + hash;
          const entry = db
            .query("SELECT uri,pending FROM mobile_attachments WHERE src=?")
            .get(src) as { uri: string; pending: number } | null;
          if (
            entry?.pending ||
            db
              .query(
                "SELECT 1 FROM mobile_attachments WHERE hash=? AND pending=1",
              )
              .get(hash)
          )
            continue;
          if (
            db.query("SELECT 1 FROM mobile_attachment_transfers LIMIT 1").get()
          )
            continue;
          if (entry) {
            const file = inspect(entry.uri);
            if (file.exists) file.delete();
            db.query(
              "DELETE FROM mobile_attachments WHERE src=? AND pending=0",
            ).run(src);
          }
          db.query("DELETE FROM mobile_site_downloads WHERE hash=?").run(hash);
          files.delete(hash);
          errors.delete(hash);
        }
      }
      emit();
    }
  }
  function prepare() {
    if (!current()) return Promise.resolve();
    queued = true;
    running ??= Promise.resolve()
      .then(drain)
      .finally(() => {
        running = null;
      });
    return running;
  }
  return {
    cached,
    needsRetry: () => errors.size > 0,
    missing,
    prepare,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    snapshot: () => version,
  };
}
