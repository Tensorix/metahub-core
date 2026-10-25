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
let upload: (file: FakeFile) => Promise<{ body: string; status: number; headers: Record<string, string> }>;
let download: (file: FakeFile, options: { signal?: AbortSignal; onProgress?(value: { bytesWritten: number; totalBytes: number }): void }) => Promise<void>;
class FakeDirectory {
  uri: string;
  constructor(...parts: (string | { uri: string })[]) { this.uri = parts.map(part => typeof part === "string" ? part : part.uri).join("/"); }
  create() {}
}
class FakeFile extends FakeDirectory {
  get exists() { return files.has(this.uri); }
  get size() { return sizes.get(this.uri) ?? files.get(this.uri)?.length ?? 0; }
  delete() { files.delete(this.uri); }
  write(bytes: Uint8Array) { files.set(this.uri, bytes.slice()); }
  copy(target: FakeFile) { target.write(files.get(this.uri)!); }
  move(target: FakeFile) { this.copy(target); this.delete(); this.uri = target.uri; }
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
  files.clear(); sizes.clear(); uploads.length = 0;
  picker = async () => ({ canceled: true });
  upload = async file => ({ status: 200, headers: {}, body: JSON.stringify({ hash: hash(await file.bytes()).slice(0, 32) }) });
  download = async () => { throw new Error("offline"); };
});
afterEach(() => { for (const resource of resources.splice(0)) { resource.dispose(); resource.db.close(); } });
function fixture() {
  const db = new Database(":memory:");
  let active = true;
  const api = { async fetch(path: string, init: RequestInit, transport: (url: string, init: RequestInit) => Promise<Response>) { return transport(`https://example.test${path}`, init); } } as unknown as AttachmentManagerOptions["api"];
  const manager = createAttachmentManager({ db, workspaceId: "test", creds: {} as AttachmentManagerOptions["creds"], api, isCurrent: () => active });
  resources.push({ db, dispose: () => manager.dispose() });
  return { db, manager, store: createAttachmentStore(db), expire: () => { active = false; } };
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
  finish({ canceled: true }); await pending;
  expect(() => f.manager.clearDownloaded()).not.toThrow();
});
test("a workspace switch during selection never checkpoints its bytes or publishes its reference", async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  picker = () => new Promise(resolve => { finish = resolve; });
  const pending = f.manager.media({ action: "pick" });
  f.expire(); finish({ canceled: false, assets: [{ uri: "file:///picker/old", name: "old" }] });
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
