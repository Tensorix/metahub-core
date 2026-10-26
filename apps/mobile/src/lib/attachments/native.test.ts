import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createAttachmentStore } from "./store";
import type { AttachmentManagerOptions } from "./native";

// Exercise the real manager and SQLite metadata with a deterministic native
// file/picker boundary. Device acceptance still covers Expo's actual modules.
const files = new Map<string, Uint8Array>();
const sizes = new Map<string, number>();
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const uploads: string[] = [];
let picker: () => Promise<unknown>;
let afterMove: (() => void) | undefined;
let trailingDirectory = false;
let upload: (file: FakeFile) => Promise<{ body: string; status: number; headers: Record<string, string> }>;
let download: (file: FakeFile, options: { signal?: AbortSignal; onProgress?(value: { bytesWritten: number; totalBytes: number }): void }) => Promise<void>;
class FakeDirectory {
  uri: string;
  constructor(...parts: (string | { uri: string })[]) { this.uri = parts.map(part => typeof part === "string" ? part : part.uri).join("/").replace(/([^/:])\/{2,}/g, "$1/"); if (trailingDirectory && new.target === FakeDirectory) this.uri += "/"; }
  create() {}
  list() { return [...files.keys()].filter(uri => uri.startsWith(`${this.uri}/`) && !uri.slice(this.uri.length + 1).includes("/")).map(uri => new FakeFile(uri)); }
}
class FakeFile extends FakeDirectory {
  get exists() { return files.has(this.uri); }
  get size() { return sizes.get(this.uri) ?? files.get(this.uri)?.length ?? 0; }
  delete() { files.delete(this.uri); sizes.delete(this.uri); }
  write(bytes: Uint8Array) { files.set(this.uri, bytes.slice()); }
  copy(target: FakeFile) { target.write(files.get(this.uri)!); }
  move(target: FakeFile) { this.copy(target); this.delete(); this.uri = target.uri; afterMove?.(); }
  async bytes() { return files.get(this.uri)!.slice(); }
  async base64() { return Buffer.from(files.get(this.uri)!).toString("base64"); }
  open() {
    const bytes = files.get(this.uri)!; let offset = 0;
    return { readBytes(count: number) { const part = bytes.slice(offset, offset + count); offset += part.length; return part; }, close() {} };
  }
  upload() { uploads.push(this.uri); return upload(this); }
  static async downloadFileAsync(_url: string, file: FakeFile, options: Parameters<typeof download>[1]) { await download(file, options); return file; }
}
mock.module("expo-file-system", () => ({ Directory: FakeDirectory, File: FakeFile, FileMode: { ReadOnly: "r" }, Paths: { document: "file:///documents" } }));
mock.module("expo-document-picker", () => ({ getDocumentAsync: () => picker() }));
mock.module("expo-image-picker", () => ({ launchImageLibraryAsync: () => picker() }));
mock.module("expo-sharing", () => ({ isAvailableAsync: async () => true, shareAsync: async () => {} }));
mock.module("react-native-quick-crypto", () => ({ default: { createHash: () => new Bun.CryptoHasher("sha256") } }));
const { createAttachmentManager } = await import("./native");
const resources: { db: Database; dispose(): void }[] = [];
beforeEach(() => {
  files.clear(); sizes.clear(); uploads.length = 0; afterMove = undefined; trailingDirectory = false;
  picker = async () => ({ canceled: true });
  upload = async file => ({ status: 200, headers: {}, body: JSON.stringify({ hash: hash(await file.bytes()).slice(0, 32) }) });
  download = async () => { throw new Error("offline"); };
});
afterEach(() => { for (const resource of resources.splice(0)) { resource.dispose(); resource.db.close(); } });
function fixture(setup?: (store: ReturnType<typeof createAttachmentStore>, db: Database) => void, initiallyActive = true) {
  const db = new Database(":memory:");
  setup?.(createAttachmentStore(db), db);
  let active = initiallyActive;
  const api = { async fetch(path: string, init: RequestInit, transport: (url: string, init: RequestInit) => Promise<Response>) { return transport(`https://example.test${path}`, init); } } as unknown as AttachmentManagerOptions["api"];
  const options = { db, workspaceId: "test", creds: {} as AttachmentManagerOptions["creds"], api, isCurrent: () => active };
  const manager = createAttachmentManager(options);
  resources.push({ db, dispose: () => manager.dispose() });
  return { db, manager, options, store: createAttachmentStore(db), expire: () => { active = false; }, activate: () => { active = true; } };
}
const waitFor = async (predicate: () => boolean) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await Bun.sleep(5); } throw new Error("Native operation did not reach expected boundary"); };
function select(name: string, contents: string) {
  const uri = `file:///picker/${name}`;
  files.set(uri, new TextEncoder().encode(contents));
  picker = async () => ({ canceled: false, assets: [{ uri, name, mimeType: "application/octet-stream" }] });
}
test("overlapping pickers and cache clearing cannot invalidate a pending selection", async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  picker = () => new Promise(resolve => { finish = resolve; });
  const pending = f.manager.media({ action: "pick" });
  await expect(f.manager.media({ action: "pick" })).rejects.toThrow("当前附件选择");
  expect(() => f.manager.clearDownloaded()).toThrow("附件传输中");
  await waitFor(() => !!finish); finish({ canceled: true }); await pending;
  expect(() => f.manager.clearDownloaded()).not.toThrow();
});
test("a workspace switch during selection never checkpoints its bytes or publishes its reference", async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  picker = () => new Promise(resolve => { finish = resolve; });
  const pending = f.manager.media({ action: "pick" });
  await waitFor(() => !!finish); f.expire(); finish({ canceled: false, assets: [{ uri: "file:///picker/old", name: "old" }] });
  await expect(pending).rejects.toThrow("附件会话已结束");
  expect(f.store.list()).toHaveLength(0); expect(uploads).toHaveLength(0);
});
test("a corrupt pending attachment stays pinned and never reaches upload transport", async () => {
  const f = fixture(); const bytes = new TextEncoder().encode("original"); const digest = hash(bytes).slice(0, 32);
  const uri = "file:///documents/damaged"; files.set(uri, new TextEncoder().encode("tampered"));
  const src = `/blob/${digest}.txt`;
  f.store.put({ src, hash: digest, name: "notes.txt", mime: "text/plain", uri, size: bytes.length, pending: 1, pinned: 1, error: null });
  await f.manager.retryPending();
  expect(uploads).toHaveLength(0); expect(f.store.get(src)?.pending).toBe(1);
  expect(f.store.get(src)?.error).toContain("校验失败");
  f.manager.clearDownloaded(); expect(files.has(uri)).toBe(true);
});
test("a second persisted attachment joins an in-flight upload drain", async () => {
  const f = fixture(); let finish!: () => void;
  upload = async file => {
    if (uploads.length === 1) await new Promise<void>(resolve => { finish = resolve; });
    return { status: 200, headers: {}, body: JSON.stringify({ hash: hash(await file.bytes()).slice(0, 32) }) };
  };
  select("one.txt", "first file"); await f.manager.media({ action: "pick" });
  await waitFor(() => !!finish);
  select("two.txt", "second file"); await f.manager.media({ action: "pick" });
  expect(f.store.pending()).toHaveLength(2);
  finish();
  await waitFor(() => f.store.pending().length === 0);
  expect(uploads).toHaveLength(2);
});
test("interrupted and corrupt downloads never become cache entries and can be retried", async () => {
  const f = fixture(); const bytes = new TextEncoder().encode("downloaded file");
  const src = `/blob/${hash(bytes).slice(0, 32)}.txt`;
  download = async file => { file.write(new TextEncoder().encode("partial")); throw new Error("connection interrupted"); };
  await expect(f.manager.cache(src)).rejects.toThrow("connection interrupted");
  expect(f.store.list()).toHaveLength(0); expect(files.size).toBe(0);
  download = async file => { file.write(new TextEncoder().encode("wrong content")); };
  await expect(f.manager.cache(src)).rejects.toThrow("附件下载校验失败");
  expect(f.store.list()).toHaveLength(0); expect(files.size).toBe(0);
  download = async file => { file.write(bytes); };
  expect(await f.manager.cache(src)).toEqual({ name: src.slice(6), size: bytes.length });
  expect(f.store.get(src)?.pinned).toBe(1);
});

test("oversized pending files are rejected before hashing or materializing their bytes", async () => {
  const f = fixture(); const uri = "file:///documents/oversized";
  files.set(uri, new Uint8Array([1])); sizes.set(uri, 201 * 1024 * 1024);
  const digest = "a".repeat(32), src = `/blob/${digest}.bin`;
  f.store.put({ src, hash: digest, name: "large.bin", mime: "application/octet-stream", uri, size: sizes.get(uri)!, pending: 1, pinned: 1, error: null });
  await f.manager.retryPending();
  expect(uploads).toHaveLength(0); expect(f.store.get(src)?.error).toContain("200 MB");
  expect(f.store.get(src)?.pending).toBe(1);
});
test("disposing a session cancels its native download and removes partial bytes", async () => {
  const f = fixture(); let started = false;
  download = (file, options) => new Promise((_resolve, reject) => {
    file.write(new TextEncoder().encode("partial")); started = true;
    options.signal!.addEventListener("abort", () => reject(new Error("cancelled transfer")), { once: true });
  });
  const pending = f.manager.cache(`/blob/${"b".repeat(32)}.bin`);
  await waitFor(() => started); f.manager.dispose();
  await expect(pending).rejects.toThrow("cancelled transfer");
  expect(files.size).toBe(0); expect(f.store.list()).toHaveLength(0);
});

test("reselecting a file repairs damaged bytes already at its canonical path", async () => {
  const f = fixture(); select("repair.txt", "original bytes");
  const first = await f.manager.media({ action: "pick" });
  await waitFor(() => f.store.pending().length === 0);
  const entry = f.store.get(first.src!)!;
  files.set(entry.uri, new TextEncoder().encode("damaged cache!"));
  select("repair.txt", "original bytes");
  const second = await f.manager.media({ action: "pick" });
  await waitFor(() => f.store.pending().length === 0);
  expect(second.src).toBe(first.src);
  expect(new TextDecoder().decode(files.get(entry.uri))).toBe("original bytes");
  expect(uploads).toHaveLength(2);
});

const attachmentDirectory = "file:///documents/attachments/74-65-73-74";
function seeded(contents = "original bytes", pending = 1) {
  const bytes = new TextEncoder().encode(contents), digest = hash(bytes).slice(0, 32);
  const src = `/blob/${digest}.txt`, uri = `${attachmentDirectory}/${src.slice(6)}`;
  return { bytes, entry: { src, hash: digest, name: "original.txt", mime: "text/plain", uri, size: bytes.length, pending, pinned: 1, error: null } };
}
test("same-size corrupt downloaded cache is verified and downloaded again", async () => {
  const { entry, bytes } = seeded("valid bytes!", 0); let downloads = 0;
  const f = fixture(store => store.put(entry));
  files.set(entry.uri, new TextEncoder().encode("wrong bytes!"));
  download = async file => { downloads++; file.write(bytes); };
  await f.manager.cache(entry.src);
  expect(downloads).toBe(1); expect(files.get(entry.uri)).toEqual(bytes);
  await f.manager.cache(entry.src); expect(downloads).toBe(1);
});
test("missing pending bytes remain pinned and expose an actionable error without fetching", async () => {
  const { entry } = seeded(); const f = fixture(store => store.put(entry)); let requested = false;
  download = async () => { requested = true; };
  await expect(f.manager.cache(entry.src)).rejects.toThrow("重新选择原文件");
  expect(requested).toBe(false); expect(f.store.get(entry.src)?.pending).toBe(1); expect(f.store.get(entry.src)?.pinned).toBe(1);
  expect(f.manager.status()[0]?.error).toContain("重新选择原文件");
});
test("retry reports failures and subscribers observe final per-entry error and success", async () => {
  const good = seeded("good bytes"), bad = seeded("bad bytes");
  const f = fixture(store => { store.put(good.entry); store.put(bad.entry); });
  files.set(good.entry.uri, good.bytes);
  const seen: string[] = [];
  const unsubscribe = f.manager.subscribe(() => { for (const row of f.manager.status()) seen.push(`${row.src}:${row.state}:${row.error ?? ""}`); });
  expect(await f.manager.retryPending()).toEqual({ uploaded: 1, failed: 1, pending: 1 });
  expect(seen.some(row => row.includes(`${good.entry.src}:uploading`))).toBe(true);
  expect(seen.some(row => row.includes(`${good.entry.src}:ready`))).toBe(true);
  expect(seen.some(row => row.includes(`${bad.entry.src}:error:附件本地文件缺失`))).toBe(true);
  unsubscribe(); expect(f.manager.status().find(row => row.src === bad.entry.src)?.error).toContain("原文件");
});
test("pending repair rejects different bytes, preserves reference and supports cancel and exact reselect", async () => {
  const { entry, bytes } = seeded(); const f = fixture(store => store.put(entry));
  expect(await f.manager.repairPending(entry.src)).toEqual({}); expect(f.store.get(entry.src)?.pending).toBe(1);
  select("different.txt", "different data");
  await expect(f.manager.repairPending(entry.src)).rejects.toThrow("所选文件与原附件不一致");
  expect(f.store.list()).toHaveLength(1); expect(f.store.get(entry.src)?.hash).toBe(entry.hash);
  expect(f.manager.status()[0]?.error).toContain("原附件不一致");
  select("renamed.txt", new TextDecoder().decode(bytes));
  expect((await f.manager.repairPending(entry.src)).src).toBe(entry.src);
  await waitFor(() => f.store.pending().length === 0);
  expect(files.get(entry.uri)).toEqual(bytes); expect(f.store.get(entry.src)?.name).toBe(entry.name);
});
test("startup journal recovers verified staged and already renamed files", async () => {
  for (const renamed of [false, true]) {
    const { entry, bytes } = seeded(renamed ? "renamed data" : "staged data");
    const tempUri = `${attachmentDirectory}/transfer-crash-${renamed}.tmp`;
    files.set(renamed ? entry.uri : tempUri, bytes);
    const f = fixture(store => store.journal({ id: tempUri, tempUri, entry }));
    await f.manager.reconcile();
    expect(f.store.get(entry.src)).toMatchObject(entry); expect(files.get(entry.uri)).toEqual(bytes);
    expect(files.has(tempUri)).toBe(false); expect(f.store.transfers()).toHaveLength(0);
  }
});
test("a rename error after moving bytes leaves a journal which recovers the pending reference", async () => {
  const f = fixture(); select("crash.txt", "persist me");
  afterMove = () => { afterMove = undefined; throw new Error("process interrupted after rename"); };
  await expect(f.manager.media({ action: "pick" })).rejects.toThrow("interrupted after rename");
  expect(f.store.list()).toHaveLength(0); expect(f.store.transfers()).toHaveLength(1);
  await f.manager.reconcile();
  expect(f.store.pending()).toHaveLength(1); expect(f.store.transfers()).toHaveLength(0);
  expect(new TextDecoder().decode(files.get(f.store.pending()[0]!.uri))).toBe("persist me");
});
test("metadata failure after rename is recoverable and a lost pending journal stays actionable", async () => {
  const f = fixture(); select("metadata.txt", "metadata bytes");
  afterMove = () => { afterMove = undefined; f.db.exec("CREATE TRIGGER fail_attachment BEFORE INSERT ON mobile_attachments BEGIN SELECT RAISE(FAIL, 'metadata interrupted'); END"); };
  await expect(f.manager.media({ action: "pick" })).rejects.toThrow("metadata interrupted");
  expect(f.store.transfers()).toHaveLength(1); f.db.exec("DROP TRIGGER fail_attachment");
  await f.manager.reconcile(); expect(f.store.pending()).toHaveLength(1); expect(f.store.transfers()).toHaveLength(0);
  const missing = seeded("lost pending");
  f.store.journal({ id: "lost", tempUri: `${attachmentDirectory}/transfer-lost.tmp`, entry: missing.entry });
  await f.manager.reconcile();
  expect(f.store.get(missing.entry.src)?.error).toContain("重新选择原文件");
  expect(f.store.get(missing.entry.src)?.pinned).toBe(1);
});
test("reconciliation deletes only journal-owned abandoned temps and accounts for unknown files", async () => {
  const abandoned = `${attachmentDirectory}/transfer-owned.tmp`, unknown = `${attachmentDirectory}/transfer-unknown.tmp`;
  const canonical = `${attachmentDirectory}/${"c".repeat(32)}.bin`;
  files.set(abandoned, new Uint8Array(3)); files.set(unknown, new Uint8Array(5)); files.set(canonical, new Uint8Array(7));
  const f = fixture(store => store.journal({ id: abandoned, tempUri: abandoned, entry: null }));
  await f.manager.reconcile();
  expect(files.has(abandoned)).toBe(false); expect(files.has(unknown)).toBe(true); expect(files.has(canonical)).toBe(true);
  expect(f.manager.usage()).toMatchObject({ bytes: 12, orphanCount: 2, orphanBytes: 12 });
  f.manager.clearDownloaded(); expect(files.has(canonical)).toBe(true); expect(files.has(unknown)).toBe(true);
});
test("reconciliation and clearing protect active downloads until their native request settles", async () => {
  const { entry, bytes } = seeded("active download", 0); const f = fixture(); let complete!: () => void;
  download = async file => { file.write(bytes.slice(0, 3)); await new Promise<void>(resolve => { complete = resolve; }); file.write(bytes); };
  const pending = f.manager.cache(entry.src); await waitFor(() => !!complete);
  const temp = f.store.transfers()[0]!.tempUri;
  await f.manager.reconcile(); expect(files.has(temp)).toBe(true);
  expect(() => f.manager.clearDownloaded()).toThrow("附件传输中");
  complete(); await pending;
  expect(f.store.transfers()).toHaveLength(0); expect(f.store.get(entry.src)?.size).toBe(bytes.length);
});

test("an abandoned journal never deletes a pending pinned file referenced by metadata", async () => {
  const { entry, bytes } = seeded(); entry.uri = `${attachmentDirectory}/transfer-pinned.tmp`;
  files.set(entry.uri, bytes);
  const f = fixture(store => { store.put(entry); store.journal({ id: "pinned", tempUri: entry.uri, entry: null }); });
  await f.manager.reconcile();
  expect(files.get(entry.uri)).toEqual(bytes); expect(f.store.get(entry.src)?.pending).toBe(1);
});
test("disposing during publication keeps a recoverable journal and suppresses notifications", async () => {
  const f = fixture(); select("session.txt", "preserve session bytes"); let notifiedAfterDispose = false, ended = false;
  f.manager.subscribe(() => { if (ended) notifiedAfterDispose = true; });
  afterMove = () => { afterMove = undefined; ended = true; f.manager.dispose(); };
  await expect(f.manager.media({ action: "pick" })).rejects.toThrow("附件会话已结束");
  expect(f.store.transfers()).toHaveLength(1); expect(f.store.list()).toHaveLength(0);
  expect(files.has(f.store.transfers()[0]!.entry!.uri)).toBe(true); expect(notifiedAfterDispose).toBe(false);
});
test("progress callbacks expose measured native download bytes", async () => {
  const { entry, bytes } = seeded("measured download", 0), f = fixture(); const measured: number[] = [];
  f.manager.subscribe(() => { const state = f.manager.status().find(row => row.src === entry.src); if (state?.state === "downloading") measured.push(state.transferred); });
  download = async (file, options) => {
    file.write(bytes); options.onProgress?.({ bytesWritten: 4, totalBytes: bytes.length });
    options.onProgress?.({ bytesWritten: bytes.length, totalBytes: bytes.length });
  };
  await f.manager.cache(entry.src); expect(measured).toContain(4); expect(measured).toContain(bytes.length);
});

test("construction permits adoption after creation and resume starts recovery", async () => {
  const { entry, bytes } = seeded(); files.set(entry.uri, bytes);
  const f = fixture(store => store.put(entry), false);
  await expect(f.manager.resume()).rejects.toThrow("附件会话已结束");
  expect(uploads).toHaveLength(0); f.activate();
  expect(await f.manager.resume()).toEqual({ uploaded: 1, failed: 0, pending: 0 });
});
test("a transient initial recovery failure can be retried on a later resume", async () => {
  const { entry, bytes } = seeded(); files.set(entry.uri, bytes);
  const f = fixture((store, db) => {
    store.journal({ id: "recover", tempUri: `${attachmentDirectory}/transfer-recover.tmp`, entry });
    db.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON mobile_attachments BEGIN SELECT RAISE(FAIL, 'temporarily unavailable'); END");
  });
  await expect(f.manager.resume()).rejects.toThrow("temporarily unavailable");
  f.db.exec("DROP TRIGGER fail_recovery");
  expect(await f.manager.resume()).toEqual({ uploaded: 1, failed: 0, pending: 0 });
  expect(f.store.transfers()).toHaveLength(0);
});
test("pinned downloads survive clearing until explicitly unpinned; pending files cannot unpin", async () => {
  const downloaded = seeded("fixed download", 0), pending = seeded("pending download", 1);
  files.set(downloaded.entry.uri, downloaded.bytes); files.set(pending.entry.uri, pending.bytes);
  const f = fixture(store => { store.put(downloaded.entry); store.put(pending.entry); });
  f.manager.clearDownloaded(); expect(files.has(downloaded.entry.uri)).toBe(true);
  expect(() => f.manager.unpinDownloaded(pending.entry.src)).toThrow("必须保持固定");
  f.manager.unpinDownloaded(downloaded.entry.src); f.manager.clearDownloaded();
  expect(files.has(downloaded.entry.uri)).toBe(false); expect(f.store.get(downloaded.entry.src)).toBeNull();
  expect(files.has(pending.entry.uri)).toBe(true);
});
test("reconciliation exposes missing downloaded files and refuses inconsistent source hashes", async () => {
  const missing = seeded("missing download", 0), invalid = seeded("invalid metadata", 1);
  invalid.entry.hash = "f".repeat(32); files.set(invalid.entry.uri, invalid.bytes);
  const f = fixture(store => { store.put(missing.entry); store.put(invalid.entry); });
  await f.manager.reconcile();
  expect(f.store.get(missing.entry.src)?.error).toContain("重新下载");
  expect(f.store.get(invalid.entry.src)?.error).toContain("元数据校验失败");
  await expect(f.manager.cache(invalid.entry.src)).rejects.toThrow("元数据校验失败");
  expect(await f.manager.retryPending()).toEqual({ uploaded: 0, failed: 1, pending: 1 }); expect(uploads).toHaveLength(0);
});
test("replacement sessions preserve active temporary files with trailing directory URIs", async () => {
  trailingDirectory = true;
  const { entry, bytes } = seeded("replacement", 0), f = fixture(); let complete!: () => void;
  download = async file => { file.write(bytes.slice(0, 2)); await new Promise<void>(resolve => { complete = resolve; }); file.write(bytes); };
  const request = f.manager.cache(entry.src); await waitFor(() => !!complete);
  const temp = f.store.transfers()[0]!.tempUri; f.manager.dispose();
  const replacement = createAttachmentManager(f.options); resources.push({ db: f.db, dispose: () => replacement.dispose() });
  await replacement.reconcile(); expect(files.has(temp)).toBe(true);
  expect(() => replacement.clearDownloaded()).toThrow("附件传输中");
  complete(); await expect(request).rejects.toThrow("附件会话已结束");
  await replacement.reconcile(); expect(files.has(temp)).toBe(false); expect(f.store.transfers()).toHaveLength(0);
  // The shared DB belongs to the original fixture; dispose the replacement
  // without closing the same SQLite connection twice in resource cleanup.
  resources.pop(); replacement.dispose();
});
