import { Directory, File, FileMode, Paths } from "expo-file-system";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Sharing from "expo-sharing";
import QuickCrypto from "react-native-quick-crypto";
import { getBucketBlob, putBucketBlob } from "../../../../../src/core/sync/storage";
import type { DbDriver } from "../../../../../src/core/driver";
import type { Credentials } from "../auth/credentials";
import type { MobileApi } from "../api/mobile-api";
import type { EditorMediaRequest } from "../editor/protocol";
import { attachmentType, createAttachmentStore, parseBlobSource, type AttachmentEntry } from "./store";

const INLINE_BYTES = 6 * 1024 * 1024;
const MAX_BYTES = 200 * 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 9 * 60_000;
/** Hash in bounded chunks and yield, including large recordings/files. */
async function hashFile(file: File, check: () => void): Promise<string> {
  const hash = QuickCrypto.createHash("sha256");
  const handle = file.open(FileMode.ReadOnly);
  try {
    let remaining = file.size;
    while (remaining > 0) {
      check();
      const bytes = handle.readBytes(Math.min(256 * 1024, remaining));
      if (!bytes.length) throw new Error("附件文件不完整");
      hash.update(bytes); remaining -= bytes.length;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    return hash.digest("hex");
  } finally { handle.close(); }
}
export interface AttachmentManagerOptions {
  db: DbDriver; workspaceId: string; creds: Credentials; api: MobileApi;
  isCurrent(): boolean;
}
export function createAttachmentManager(options: AttachmentManagerOptions) {
  const store = createAttachmentStore(options.db);
  const directory = new Directory(Paths.document, "attachments", Array.from(options.workspaceId).map(c => c.codePointAt(0)!.toString(16)).join("-"));
  directory.create({ intermediates: true, idempotent: true });
  let disposed = false;
  const cancellation = new AbortController();
  let retrying: Promise<void> | null = null;
  let retryAgain = false;
  let picking = false;
  const current = () => { if (disposed || !options.isCurrent()) throw new Error("附件会话已结束"); };
  const alive = () => !disposed && options.isCurrent();
  const downloads = new Map<string, Promise<AttachmentEntry>>();
  const temporary = () => new File(directory, `transfer-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  const remove = (file: File) => { try { if (file.exists) file.delete(); } catch { /* interrupted files are never referenced */ } };
  const startTransfer = () => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    cancellation.signal.addEventListener("abort", abort, { once: true });
    if (cancellation.signal.aborted) abort();
    // Finish before the bridge's ten-minute media timeout so a stalled native
    // transfer can be retried instead of remaining in downloads indefinitely.
    const timer = setTimeout(abort, TRANSFER_TIMEOUT_MS);
    return { signal: controller.signal, abort, finish() { clearTimeout(timer); cancellation.signal.removeEventListener("abort", abort); } };
  };
  async function upload(entry: AttachmentEntry) {
    current();
    const file = new File(entry.uri);
    if (!file.exists) throw new Error("附件本地文件缺失，请重新选择");
    if (!file.size || file.size > MAX_BYTES) throw new Error("附件需要在 200 MB 以内且不能为空");
    // Pending files can survive many process restarts. Never publish damaged
    // bytes under an immutable content address, including bucket transports.
    if (file.size !== entry.size || !(await hashFile(file, current)).startsWith(entry.hash)) throw new Error("附件本地文件校验失败，请重新选择");
    current();
    const transfer = startTransfer();
    try {
      if (options.creds.bucket) {
        const bytes = await file.bytes(); current();
        if (bytes.length > MAX_BYTES) throw new Error("附件超过本机 200 MB 限制");
        await putBucketBlob(options.creds.bucket, entry.hash, bytes, { signal: transfer.signal, maxBytes: MAX_BYTES });
      } else {
        const res = await options.api.fetch("/api/blob", { method: "POST", headers: { "content-type": entry.mime } }, async (url, init) => {
          current();
          const result = await file.upload(url, { httpMethod: "POST", headers: Object.fromEntries(new Headers(init?.headers).entries()), signal: transfer.signal });
          return new Response(result.body, { status: result.status, headers: result.headers });
        });
        if (!res.ok) throw new Error(`附件上传失败（${res.status}）`);
        const response = await res.json() as { hash?: string };
        if (response.hash !== entry.hash) throw new Error("附件上传校验失败");
      }
      current(); store.uploaded(entry.src);
    } finally { transfer.finish(); }
  }
  async function retryPending() {
    current();
    retryAgain = true;
    if (retrying) return retrying;
    retrying = (async () => {
      do {
        retryAgain = false;
        for (const entry of store.pending()) {
          if (!alive()) return;
          try { await upload(entry); }
          catch (error) { if (alive()) store.failed(entry.src, error instanceof Error ? error.message : String(error)); }
        }
        // A picker may have persisted another attachment during an upload.
      } while (retryAgain && alive());
    })().finally(() => { retrying = null; });
    return retrying;
  }
  async function pick(kind: EditorMediaRequest["kind"] = "file") {
    current();
    let selected: { uri: string; name: string; mime: string };
    if (kind === "image" || kind === "video") {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: kind === "image" ? ["images"] : ["videos"], quality: 1 });
      current(); if (result.canceled) return {};
      const asset = result.assets[0]!;
      selected = { uri: asset.uri, name: asset.fileName ?? "附件", mime: asset.mimeType ?? "application/octet-stream" };
    } else {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false, type: kind === "audio" ? "audio/*" : "*/*" });
      current(); if (result.canceled) return {};
      const asset = result.assets[0]!;
      selected = { uri: asset.uri, name: asset.name, mime: asset.mimeType ?? "application/octet-stream" };
    }
    const source = new File(selected.uri);
    if (!source.size || source.size > MAX_BYTES) throw new Error("附件需要在 200 MB 以内且不能为空");
    const temp = temporary();
    try {
      await source.copy(temp); current();
      if (!temp.size || temp.size > MAX_BYTES) throw new Error("附件需要在 200 MB 以内且不能为空");
      const hash = (await hashFile(temp, current)).slice(0, 32); current();
      const type = attachmentType(selected.mime, selected.name);
      const src = `/blob/${hash}${type.extension ? `.${type.extension}` : ""}`;
      const target = new File(directory, src.slice(6));
      // The canonical path may outlive its metadata or contain damaged bytes.
      // Replace it with this verified copy so reselecting can repair the cache.
      await temp.move(target, { overwrite: true });
      current();
      store.put({ src, hash, name: selected.name, mime: type.mime, uri: target.uri, size: target.size, pending: 1, pinned: 1, error: null });
      void retryPending().catch(() => {});
      return { src, name: selected.name, mime: type.mime };
    } catch (error) { remove(temp); throw error; }
  }
  async function download(src: string): Promise<AttachmentEntry> {
    current();
    const parsed = parseBlobSource(src);
    const previous = store.get(src);
    if (previous && new File(previous.uri).exists) return previous;
    const temp = temporary();
    const transfer = startTransfer();
    try {
      const mime = attachmentType("application/octet-stream", src).mime;
      if (options.creds.bucket) {
        const bytes = await getBucketBlob(options.creds.bucket, parsed.hash, { signal: transfer.signal, maxBytes: MAX_BYTES }); current();
        if (!bytes) throw new Error("附件尚未上传，恢复网络后重试");
        temp.write(bytes);
      } else {
        // Use the authenticated transport for renewal, with native streaming to
        // disk. Partial Android downloads never become visible cache entries.
        const res = await options.api.fetch(src, {}, async (url, init) => {
          current();
          try {
            await File.downloadFileAsync(url, temp, { headers: Object.fromEntries(new Headers(init?.headers).entries()), idempotent: true, signal: transfer.signal, onProgress: progress => { if (progress.bytesWritten > MAX_BYTES || progress.totalBytes > MAX_BYTES) transfer.abort(); } });
            return new Response(null, { status: 200 });
          } catch (error) {
            const status = /(?:status|code)[^\d]*(\d{3})/i.exec(String(error))?.[1];
            if (status) return new Response(null, { status: Number(status) });
            throw error;
          }
        });
        if (!res.ok) throw new Error(`附件下载失败（${res.status}），联网后重试`);
      }
      current();
      if (temp.size > MAX_BYTES) throw new Error("附件超过本机 200 MB 限制");
      const actualHash = await hashFile(temp, current); current();
      if (!actualHash.startsWith(parsed.hash)) throw new Error("附件下载校验失败");
      const target = new File(directory, src.slice(6));
      // The canonical path may outlive its metadata or contain damaged bytes.
      // Replace it with this verified copy so reselecting can repair the cache.
      await temp.move(target, { overwrite: true });
      current();
      const entry: AttachmentEntry = { src, hash: parsed.hash, name: previous?.name ?? src.slice(6), mime: previous?.mime ?? mime, uri: target.uri, size: target.size, pending: previous?.pending ?? 0, pinned: 1, error: null };
      store.put(entry); return entry;
    } catch (error) { remove(temp); throw error; }
    finally { transfer.finish(); }
  }
  async function ensure(src: string) {
    current(); parseBlobSource(src);
    let request = downloads.get(src);
    if (!request) { request = download(src).finally(() => downloads.delete(src)); downloads.set(src, request); }
    return request;
  }
  return {
    retryPending,
    async cache(src: string) { const entry = await ensure(src); current(); return { name: entry.name, size: entry.size }; },
    usage() { current(); const entries = store.list(); return { count: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0), pending: entries.filter(entry => entry.pending).length }; },
    clearDownloaded() {
      current();
      if (downloads.size || retrying || picking) throw new Error("附件传输中，请稍后清理缓存");
      for (const entry of store.list()) {
        if (entry.pending) continue;
        remove(new File(entry.uri)); store.removeDownloaded(entry.src);
      }
    },
    dispose() { disposed = true; cancellation.abort(); },
    pendingCount() { current(); return store.pending().length; },
    async media(request: EditorMediaRequest): Promise<{ src?: string; url?: string; name?: string; mime?: string }> {
      current();
      if (request.action === "pick") {
        if (picking) throw new Error("请先完成当前附件选择");
        picking = true;
        try { return await pick(request.kind); }
        finally { picking = false; }
      }
      const entry = await ensure(request.src!); current();
      if (request.action === "preview") {
        if (!await Sharing.isAvailableAsync()) throw new Error("此设备无法打开附件预览");
        current(); await Sharing.shareAsync(entry.uri, { mimeType: entry.mime, dialogTitle: entry.name }); current();
        return { src: entry.src, name: entry.name, mime: entry.mime };
      }
      if (entry.size > INLINE_BYTES) return { src: entry.src, name: entry.name, mime: entry.mime };
      const base64 = await new File(entry.uri).base64(); current();
      return { src: entry.src, url: `data:${entry.mime};base64,${base64}`, name: entry.name, mime: entry.mime };
    },
  };
}
export type AttachmentManager = ReturnType<typeof createAttachmentManager>;
