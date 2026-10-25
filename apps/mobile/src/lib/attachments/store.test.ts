import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttachmentStore, parseBlobSource, attachmentType } from "./store";

test("pending attachments and pinned downloads survive database reopen and failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "metahub-attachments-"));
  const file = join(directory, "cache.db");
  let db = new Database(file);
  let store = createAttachmentStore(db);
  const src = `/blob/${"a".repeat(32)}.png`;
  const entry = { src, hash: "a".repeat(32), name: "image.png", mime: "image/png", uri: "file:///private/image.png", size: 20, pending: 1, pinned: 1, error: null };
  store.put(entry); store.failed(src, "offline");
  db.close(); db = new Database(file);
  store = createAttachmentStore(db);
  expect(store.pending()).toHaveLength(1);
  expect(store.get(src)?.error).toBe("offline");
  // A download/cache metadata update must never erase a pending upload.
  store.put({ ...entry, pending: 0, pinned: 0 });
  expect(store.get(src)?.pending).toBe(1); expect(store.get(src)?.pinned).toBe(1);
  store.removeDownloaded(src); expect(store.get(src)?.pending).toBe(1);
  store.uploaded(src);
  expect(store.pending()).toHaveLength(0); expect(store.get(src)?.error).toBeNull(); expect(store.get(src)?.pinned).toBe(1);
  db.close(); rmSync(directory, { recursive: true, force: true });
});
test("canonical blob references accept old hashes and reject path/query injection", () => {
  expect(parseBlobSource(`/blob/${"a".repeat(32)}.jpg`)).toEqual({ hash: "a".repeat(32), extension: "jpg" });
  expect(parseBlobSource(`/blob/${"b".repeat(64)}`)).toEqual({ hash: "b".repeat(64), extension: "" });
  for (const src of ["https://host/blob/abc", "/blob/../secret", `/blob/${"a".repeat(32)}?token=secret`, "/blob/nohash.png"]) expect(() => parseBlobSource(src)).toThrow();
  expect(attachmentType("image/jpeg", "camera.HEIC")).toEqual({ mime: "image/jpeg", extension: "jpg" });
  expect(attachmentType("application/octet-stream", "clip.mp4")).toEqual({ mime: "video/mp4", extension: "mp4" });
});
