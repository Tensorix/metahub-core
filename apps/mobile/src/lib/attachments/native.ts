import { Directory, File, FileMode, Paths } from "expo-file-system";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Sharing from "expo-sharing";
import QuickCrypto from "react-native-quick-crypto";
import {
  getBucketBlob,
  putBucketBlob,
} from "../../../../../src/core/sync/storage";
import type { DbDriver } from "../../../../../src/core/driver";
import type { Credentials } from "../auth/credentials";
import type { MobileApi } from "../api/mobile-api";
import type { EditorMediaRequest } from "../editor/protocol";
import type { NativePresentation } from "../editor/native-presentation";
import {
  attachmentType,
  createAttachmentStore,
  parseBlobSource,
  type AttachmentEntry,
  type AttachmentTransfer,
} from "./store";

const INLINE_BYTES = 6 * 1024 * 1024;
const MAX_BYTES = 200 * 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 9 * 60_000;
const presentDirectly: NativePresentation = (open) => open();
// Shared across managers: a replacement session must not reconcile a previous
// session's native request until that request has actually settled.
const activeTemps = new Set<string>();
/** Hash in bounded chunks and yield, including large recordings/files. */
async function hashFile(file: File, check: () => void): Promise<string> {
  const hash = QuickCrypto.createHash("sha256");
  const handle = file.open(FileMode.ReadOnly);
  try {
    let remaining = file.size;
    while (remaining > 0) {
      check();
      const bytes = await handle.readBytes(Math.min(256 * 1024, remaining));
      check();
      if (!bytes.length) throw new Error("附件文件不完整");
      hash.update(bytes);
      remaining -= bytes.length;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return hash.digest("hex");
  } finally {
    handle.close();
  }
}
export interface AttachmentManagerOptions {
  db: DbDriver;
  workspaceId: string;
  creds: Credentials;
  api: MobileApi;
  isCurrent(): boolean;
}
export interface RetryPendingReport {
  uploaded: number;
  failed: number;
  pending: number;
}
export interface AttachmentStatus extends AttachmentEntry {
  state:
    "queued" | "checking" | "uploading" | "downloading" | "ready" | "error";
  transferred: number;
  total: number;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export function createAttachmentManager(options: AttachmentManagerOptions) {
  const store = createAttachmentStore(options.db);
  const directory = new Directory(
    Paths.document,
    "attachments",
    Array.from(options.workspaceId)
      .map((c) => c.codePointAt(0)!.toString(16))
      .join("-"),
  );
  directory.create({ intermediates: true, idempotent: true });
  const directoryUri = directory.uri.replace(/\/+$/, "");
  let disposed = false;
  const cancellation = new AbortController();
  let retrying: Promise<RetryPendingReport> | null = null;
  let retryAgain = false;
  let picking = false;
  let reconciling: Promise<void> | null = null;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const progress = new Map<string, Partial<AttachmentStatus>>();
  const current = () => {
    if (disposed || !options.isCurrent()) throw new Error("附件会话已结束");
  };
  const alive = () => !disposed && options.isCurrent();
  const downloads = new Map<string, Promise<AttachmentEntry>>();
  const emit = () => {
    if (alive())
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          /* A view cannot interrupt persistence. */
        }
      }
  };
  const update = (src: string, value: Partial<AttachmentStatus>) => {
    if (alive()) {
      progress.set(src, { ...progress.get(src), ...value });
      emit();
    }
  };
  const failed = (src: string, error: unknown) => {
    if (alive()) {
      store.failed(src, message(error));
      update(src, { state: "error", error: message(error) });
    }
  };
  const remove = (uri: string) => {
    const file = new File(uri);
    if (file.exists) file.delete();
  };
  const quietRemove = (uri: string) => {
    try {
      remove(uri);
      return true;
    } catch {
      return false;
    }
  };
  const temporary = (): AttachmentTransfer => {
    const temp = new File(
      directory,
      `transfer-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    const transfer = { id: temp.uri, tempUri: temp.uri, entry: null };
    // Persist ownership before any copy/download can leave bytes on disk.
    store.journal(transfer);
    activeTemps.add(temp.uri);
    return transfer;
  };
  const startTransfer = () => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    cancellation.signal.addEventListener("abort", abort, { once: true });
    if (cancellation.signal.aborted) abort();
    const timer = setTimeout(abort, TRANSFER_TIMEOUT_MS);
    return {
      signal: controller.signal,
      abort,
      finish() {
        clearTimeout(timer);
        cancellation.signal.removeEventListener("abort", abort);
      },
    };
  };
  function metadataError(entry: AttachmentEntry): string | null {
    try {
      if (parseBlobSource(entry.src).hash === entry.hash) return null;
    } catch {
      /* Invalid source is also inconsistent metadata. */
    }
    return "附件元数据校验失败，附件引用与原文件哈希不一致";
  }
  async function valid(file: File, entry: AttachmentEntry) {
    if (metadataError(entry)) return false;
    return (
      file.exists &&
      file.size === entry.size &&
      file.size > 0 &&
      file.size <= MAX_BYTES &&
      (await hashFile(file, current)).startsWith(entry.hash)
    );
  }
  function scheduleReconciliation() {
    if (!alive() || idle) return;
    idle = setTimeout(() => {
      idle = undefined;
      if (alive()) void reconcile().catch(() => {});
    }, 0);
  }
  function finishTemporary(transfer: AttachmentTransfer, published: boolean) {
    activeTemps.delete(transfer.tempUri);
    // Once renamed, the File object's URI changes. Always clean the original
    // temporary URI; the journal owns recovery of a published canonical file.
    if (!published && quietRemove(transfer.tempUri) && alive())
      store.forgetTransfer(transfer.id);
    scheduleReconciliation();
  }
  async function publish(transfer: AttachmentTransfer, entry: AttachmentEntry) {
    current();
    transfer.entry = entry;
    store.journal(transfer);
    const source = new File(transfer.tempUri);
    await source.move(new File(entry.uri), { overwrite: true });
    current();
    store.put(entry);
    store.forgetTransfer(transfer.id);
    emit();
  }
  async function recover() {
    const protectedUris = new Set(store.list().map((entry) => entry.uri));
    const removeAbandoned = (transfer: AttachmentTransfer) => {
      // Journal ownership alone cannot override a pinned metadata reference,
      // nor authorize deleting a canonical or unrelated file.
      const name = transfer.tempUri.slice(directoryUri.length + 1);
      if (
        !transfer.tempUri.startsWith(`${directoryUri}/`) ||
        !/^transfer-[^/]+\.tmp$/.test(name)
      )
        return false;
      if (protectedUris.has(transfer.tempUri)) return true;
      return quietRemove(transfer.tempUri);
    };
    for (const transfer of store.transfers()) {
      current();
      if (activeTemps.has(transfer.tempUri)) continue;
      const entry = transfer.entry;
      if (!entry) {
        if (removeAbandoned(transfer)) store.forgetTransfer(transfer.id);
        continue;
      }
      const error = metadataError(entry);
      if (error) {
        store.put(entry);
        store.failed(entry.src, error);
        store.forgetTransfer(transfer.id);
        continue;
      }
      const target = new File(entry.uri),
        temp = new File(transfer.tempUri);
      if (await valid(target, entry)) {
        current();
        store.put(entry);
        if (removeAbandoned(transfer)) store.forgetTransfer(transfer.id);
      } else if (await valid(temp, entry)) {
        await publish(transfer, entry);
      } else {
        current();
        // A pending reference must survive even if both crash remnants were
        // lost or damaged. Never silently replace its immutable content hash.
        if (entry.pending) {
          store.put(entry);
          store.failed(
            entry.src,
            "附件本地文件缺失或校验失败，请重新选择原文件修复",
          );
        }
        if (removeAbandoned(transfer)) store.forgetTransfer(transfer.id);
      }
    }
    for (const entry of store.list()) {
      current();
      const error =
        metadataError(entry) ??
        (!new File(entry.uri).exists
          ? entry.pending
            ? "附件本地文件缺失，请重新选择原文件修复"
            : "附件缓存缺失，请联网后重新下载"
          : null);
      if (error) failed(entry.src, error);
    }
    current();
    emit();
  }
  function reconcile(): Promise<void> {
    current();
    if (!reconciling)
      reconciling = recover().finally(() => {
        reconciling = null;
      });
    return reconciling;
  }
  // The session adopts this manager after construction. Recovery starts on
  // resume/first operation, and every later request can retry a transient fault.
  async function ready() {
    current();
    await reconcile();
    current();
  }
  async function upload(entry: AttachmentEntry) {
    current();
    update(entry.src, {
      state: "checking",
      transferred: 0,
      total: entry.size,
      error: null,
    });
    const file = new File(entry.uri);
    if (metadataError(entry)) throw new Error(metadataError(entry)!);
    if (!file.exists) throw new Error("附件本地文件缺失，请重新选择原文件修复");
    if (!file.size || file.size > MAX_BYTES)
      throw new Error("附件需要在 200 MB 以内且不能为空");
    if (!(await valid(file, entry)))
      throw new Error("附件本地文件校验失败，请重新选择原文件修复");
    current();
    update(entry.src, { state: "uploading" });
    const transfer = startTransfer();
    try {
      if (options.creds.bucket) {
        const bytes = await file.bytes();
        current();
        if (bytes.length > MAX_BYTES)
          throw new Error("附件超过本机 200 MB 限制");
        await putBucketBlob(options.creds.bucket, entry.hash, bytes, {
          signal: transfer.signal,
          maxBytes: MAX_BYTES,
        });
      } else {
        const res = await options.api.fetch(
          "/api/blob",
          { method: "POST", headers: { "content-type": entry.mime } },
          async (url, init) => {
            current();
            const result = await file.upload(url, {
              httpMethod: "POST",
              headers: Object.fromEntries(new Headers(init?.headers).entries()),
              signal: transfer.signal,
              onProgress: (value) =>
                update(entry.src, {
                  transferred: value.bytesSent,
                  total: value.totalBytes,
                }),
            });
            return new Response(result.body, {
              status: result.status,
              headers: result.headers,
            });
          },
        );
        if (!res.ok) throw new Error(`附件上传失败（${res.status}）`);
        const response = (await res.json()) as { hash?: string };
        if (response.hash !== entry.hash) throw new Error("附件上传校验失败");
      }
      current();
      store.uploaded(entry.src);
      update(entry.src, {
        state: "ready",
        pending: 0,
        transferred: entry.size,
        error: null,
      });
    } finally {
      transfer.finish();
    }
  }
  async function retryPending(): Promise<RetryPendingReport> {
    await ready();
    retryAgain = true;
    if (retrying) return retrying;
    retrying = (async () => {
      const uploaded = new Set<string>(),
        errors = new Set<string>();
      const initialPending = store.pending().length;
      do {
        retryAgain = false;
        const candidates = store.pending();
        for (const entry of candidates) {
          if (!alive())
            return {
              uploaded: uploaded.size,
              failed: errors.size,
              pending: candidates.length,
            };
          try {
            await upload(entry);
            uploaded.add(entry.src);
            errors.delete(entry.src);
          } catch (error) {
            if (alive()) {
              failed(entry.src, error);
              errors.add(entry.src);
            }
          }
        }
      } while (retryAgain && alive());
      return {
        uploaded: uploaded.size,
        failed: errors.size,
        pending: alive()
          ? store.pending().length
          : Math.max(0, initialPending - uploaded.size),
      };
    })().finally(() => {
      retrying = null;
      scheduleReconciliation();
    });
    return retrying;
  }
  async function select(
    kind: EditorMediaRequest["kind"] = "file",
    present: NativePresentation = presentDirectly,
  ) {
    if (kind === "image" || kind === "video") {
      const result = await present(() => {
        current();
        return ImagePicker.launchImageLibraryAsync({
          mediaTypes: kind === "image" ? ["images"] : ["videos"],
          quality: 1,
        });
      });
      current();
      if (result.canceled) return;
      const asset = result.assets[0]!;
      return {
        uri: asset.uri,
        name: asset.fileName ?? "附件",
        mime: asset.mimeType ?? "application/octet-stream",
      };
    }
    const result = await present(() => {
      current();
      return DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
        type: kind === "audio" ? "audio/*" : "*/*",
      });
    });
    current();
    if (result.canceled) return;
    const asset = result.assets[0]!;
    return {
      uri: asset.uri,
      name: asset.name,
      mime: asset.mimeType ?? "application/octet-stream",
    };
  }
  async function pick(
    kind?: EditorMediaRequest["kind"],
    repair?: AttachmentEntry,
    present?: NativePresentation,
  ) {
    await ready();
    const selected = await select(kind, present);
    if (!selected) return {};
    const source = new File(selected.uri);
    if (!source.size || source.size > MAX_BYTES)
      throw new Error("附件需要在 200 MB 以内且不能为空");
    const transfer = temporary(),
      temp = new File(transfer.tempUri);
    let published = false;
    try {
      await source.copy(temp);
      current();
      if (!temp.size || temp.size > MAX_BYTES)
        throw new Error("附件需要在 200 MB 以内且不能为空");
      const actualHash = await hashFile(temp, current);
      current();
      if (
        repair &&
        (!actualHash.startsWith(repair.hash) || temp.size !== repair.size)
      )
        throw new Error("所选文件与原附件不一致，请选择原文件；附件引用未更改");
      const hash = repair?.hash ?? actualHash.slice(0, 32);
      const type = attachmentType(selected.mime, selected.name);
      const src =
        repair?.src ??
        `/blob/${hash}${type.extension ? `.${type.extension}` : ""}`;
      const target = new File(directory, src.slice(6));
      const entry = {
        src,
        hash,
        name: repair?.name ?? selected.name,
        mime: repair?.mime ?? type.mime,
        uri: target.uri,
        size: temp.size,
        pending: 1,
        pinned: 1,
        error: null,
      };
      // Mark publication before awaiting move, so a crash/error after rename
      // keeps the durable journal for the next reconciliation.
      published = true;
      await publish(transfer, entry);
      progress.delete(src);
      emit();
      void retryPending().catch(() => {});
      return { src, name: entry.name, mime: entry.mime };
    } finally {
      finishTemporary(transfer, published);
    }
  }
  async function download(src: string): Promise<AttachmentEntry> {
    await ready();
    const parsed = parseBlobSource(src);
    const previous = store.get(src);
    if (previous) {
      const error = metadataError(previous);
      if (error) {
        failed(src, error);
        throw new Error(error);
      }
      update(src, { state: "checking", error: null });
      if (await valid(new File(previous.uri), previous)) {
        update(src, {
          state: previous.error
            ? "error"
            : previous.pending
              ? "queued"
              : "ready",
          error: previous.error,
        });
        return previous;
      }
      current();
      if (previous.pending) {
        const error = new Error(
          "附件本地文件缺失或校验失败，请重新选择原文件修复",
        );
        failed(src, error);
        throw error;
      }
    }
    const journal = temporary(),
      temp = new File(journal.tempUri);
    const transfer = startTransfer();
    let published = false;
    const mime = attachmentType("application/octet-stream", src).mime;
    const loading: AttachmentEntry = previous ?? {
      src,
      hash: parsed.hash,
      name: src.slice(6),
      mime,
      uri: "",
      size: 0,
      pending: 0,
      pinned: 1,
      error: null,
    };
    update(src, {
      ...loading,
      state: "downloading",
      transferred: 0,
      total: previous?.size ?? 0,
      error: null,
    });
    try {
      if (options.creds.bucket) {
        const bytes = await getBucketBlob(options.creds.bucket, parsed.hash, {
          signal: transfer.signal,
          maxBytes: MAX_BYTES,
        });
        current();
        if (!bytes) throw new Error("附件尚未上传，恢复网络后重试");
        temp.write(bytes);
        update(src, { transferred: bytes.length, total: bytes.length });
      } else {
        const res = await options.api.fetch(src, {}, async (url, init) => {
          current();
          try {
            await File.downloadFileAsync(url, temp, {
              headers: Object.fromEntries(new Headers(init?.headers).entries()),
              idempotent: true,
              signal: transfer.signal,
              onProgress: (value) => {
                update(src, {
                  transferred: value.bytesWritten,
                  total: value.totalBytes,
                });
                if (
                  value.bytesWritten > MAX_BYTES ||
                  value.totalBytes > MAX_BYTES
                )
                  transfer.abort();
              },
            });
            return new Response(null, { status: 200 });
          } catch (error) {
            const status = /(?:status|code)[^\d]*(\d{3})/i.exec(
              String(error),
            )?.[1];
            if (status) return new Response(null, { status: Number(status) });
            throw error;
          }
        });
        if (!res.ok)
          throw new Error(`附件下载失败（${res.status}），联网后重试`);
      }
      current();
      if (temp.size > MAX_BYTES) throw new Error("附件超过本机 200 MB 限制");
      if (
        !temp.size ||
        !(await hashFile(temp, current)).startsWith(parsed.hash)
      )
        throw new Error("附件下载校验失败");
      current();
      const target = new File(directory, src.slice(6));
      const entry: AttachmentEntry = {
        ...loading,
        uri: target.uri,
        size: temp.size,
        pending: 0,
        error: null,
      };
      published = true;
      await publish(journal, entry);
      update(src, {
        ...entry,
        state: "ready",
        transferred: entry.size,
        total: entry.size,
      });
      return entry;
    } catch (error) {
      failed(src, error);
      throw error;
    } finally {
      transfer.finish();
      finishTemporary(journal, published);
    }
  }
  async function ensure(src: string) {
    current();
    parseBlobSource(src);
    let request = downloads.get(src);
    if (!request) {
      request = download(src).finally(() => {
        downloads.delete(src);
        scheduleReconciliation();
      });
      downloads.set(src, request);
    }
    return request;
  }
  const status = (): AttachmentStatus[] => {
    current();
    const entries = new Map(store.list().map((entry) => [entry.src, entry]));
    for (const [src, value] of progress)
      if (!entries.has(src) && value.hash)
        entries.set(src, value as AttachmentEntry);
    return [...entries.values()].map((entry) => ({
      ...entry,
      state: entry.error ? "error" : entry.pending ? "queued" : "ready",
      transferred: 0,
      total: entry.size,
      ...progress.get(entry.src),
    }));
  };
  return {
    retryPending,
    reconcile,
    async resume() {
      return retryPending();
    },
    status,
    subscribe(listener: () => void) {
      current();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async repairPending(src: string, kind?: EditorMediaRequest["kind"]) {
      current();
      parseBlobSource(src);
      const entry = store.get(src);
      if (!entry?.pending) throw new Error("该附件没有待修复的上传");
      if (metadataError(entry)) throw new Error(metadataError(entry)!);
      if (picking) throw new Error("请先完成当前附件选择");
      picking = true;
      try {
        return await pick(kind, entry);
      } catch (error) {
        failed(src, error);
        throw error;
      } finally {
        picking = false;
        scheduleReconciliation();
      }
    },
    async cache(src: string) {
      const entry = await ensure(src);
      current();
      return { name: entry.name, size: entry.size };
    },
    usage() {
      current();
      const entries = store.list(),
        known = new Set(entries.map((entry) => entry.uri));
      // Unknown files are retained and counted. Only journal-owned abandoned
      // temporaries are eligible for automatic deletion.
      const orphans = directory
        .list()
        .filter(
          (item): item is File => item instanceof File && !known.has(item.uri),
        );
      const orphanBytes = orphans.reduce((sum, file) => sum + file.size, 0);
      return {
        count: entries.length,
        bytes:
          entries.reduce(
            (sum, entry) =>
              sum + (new File(entry.uri).exists ? new File(entry.uri).size : 0),
            0,
          ) + orphanBytes,
        pending: entries.filter((entry) => entry.pending).length,
        orphanCount: orphans.length,
        orphanBytes,
      };
    },
    unpinDownloaded(src: string) {
      current();
      parseBlobSource(src);
      if (downloads.size || retrying || picking || reconciling)
        throw new Error("附件传输中，请稍后取消固定");
      const entry = store.get(src);
      if (entry?.pending)
        throw new Error("待上传附件必须保持固定，请先修复并上传");
      store.unpinDownloaded(src);
      progress.delete(src);
      emit();
    },
    clearDownloaded() {
      current();
      if (
        downloads.size ||
        retrying ||
        picking ||
        reconciling ||
        [...activeTemps].some((uri) => uri.startsWith(`${directoryUri}/`))
      )
        throw new Error("附件传输中，请稍后清理缓存");
      for (const entry of store.list()) {
        if (entry.pending || entry.pinned) continue;
        remove(entry.uri);
        store.removeDownloaded(entry.src);
        progress.delete(entry.src);
      }
      emit();
    },
    dispose() {
      disposed = true;
      cancellation.abort();
      if (idle) clearTimeout(idle);
      listeners.clear();
    },
    pendingCount() {
      current();
      return store.pending().length;
    },
    async media(
      request: EditorMediaRequest,
      present: NativePresentation = presentDirectly,
    ): Promise<{ src?: string; url?: string; name?: string; mime?: string }> {
      current();
      if (request.action === "pick") {
        if (picking) throw new Error("请先完成当前附件选择");
        picking = true;
        try {
          return await pick(request.kind, undefined, present);
        } finally {
          picking = false;
          scheduleReconciliation();
        }
      }
      const entry = await ensure(request.src!);
      current();
      if (request.action === "preview") {
        if (!(await Sharing.isAvailableAsync()))
          throw new Error("此设备无法打开附件预览");
        await present(() => {
          current();
          return Sharing.shareAsync(entry.uri, {
            mimeType: entry.mime,
            dialogTitle: entry.name,
          });
        });
        current();
        return { src: entry.src, name: entry.name, mime: entry.mime };
      }
      if (entry.size > INLINE_BYTES)
        return { src: entry.src, name: entry.name, mime: entry.mime };
      const base64 = await new File(entry.uri).base64();
      current();
      return {
        src: entry.src,
        url: `data:${entry.mime};base64,${base64}`,
        name: entry.name,
        mime: entry.mime,
      };
    },
  };
}
export type AttachmentManager = ReturnType<typeof createAttachmentManager>;
