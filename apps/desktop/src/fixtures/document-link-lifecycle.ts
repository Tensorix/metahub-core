// Run in a separate Bun process so Electron mocks cannot leak into other tests.
// Exercise the actual main/preload code without starting Electron or a database.
import { mock, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scenario = process.argv[2]!;
const profile = mkdtempSync(join(tmpdir(), "mh-protocol-lifecycle-"));
process.on("exit", () => rmSync(profile, { recursive: true, force: true }));
delete process.env.MH_TEST_USER_DATA;
Object.defineProperty(process, "resourcesPath", { value: profile });
let ready!: () => void;
const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
let healthy!: (response: Response) => void;
const healthPromise = new Promise<Response>((resolve) => { healthy = resolve; });
globalThis.fetch = (() => healthPromise) as unknown as typeof fetch;
const registrations: string[] = [];
let quit = false;
const app = Object.assign(new EventEmitter(), {
  isPackaged: scenario !== "dev",
  getPath: () => profile,
  setPath: () => {},
  getAppPath: () => profile,
  getLocale: () => "en",
  requestSingleInstanceLock: () => scenario !== "secondary",
  setAsDefaultProtocolClient: (scheme: string) => { registrations.push(scheme); return true; },
  quit: () => { quit = true; },
  whenReady: () => readyPromise,
});
const ipcRenderer = new EventEmitter();
let bridge: any;
// Preload only registers a load listener at module evaluation; the page itself
// isn't booted by this harness, so timing/perf IPC remains dormant.
Object.assign(globalThis, { window: { addEventListener() {} } });
class Window extends EventEmitter {
  static all: Window[] = [];
  url = "";
  loading = true;
  destroyed = false;
  minimized = false;
  shown = false;
  focused = false;
  webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => this.destroyed,
    isLoading: () => this.loading,
    setWindowOpenHandler: () => {},
    send: (channel: string, payload: unknown) => ipcRenderer.emit(channel, {}, payload),
  });
  constructor(public options: any) { super(); Window.all.push(this); }
  loadURL(url: string) { this.url = url; return Promise.resolve(); }
  loadFile() { return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized; }
  restore() { this.minimized = false; }
  show() { this.shown = true; }
  focus() { this.focused = true; }
  finish() { this.loading = false; this.webContents.emit("did-finish-load"); }
  close() { this.destroyed = true; this.emit("closed"); }
}
class Tray extends EventEmitter { setToolTip() {} setContextMenu() {} }
mock.module("electron", () => ({
  app, BrowserWindow: Window, Tray, ipcRenderer,
  contextBridge: { exposeInMainWorld: (_key: string, value: unknown) => { bridge = value; } },
  dialog: { showErrorBox: (title: string, message: string) => { throw new Error(`${title}: ${message}`); } },
  globalShortcut: { register: () => true, unregister() {} },
  ipcMain: Object.assign(new EventEmitter(), { handle() {} }),
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
  nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
  nativeTheme: { shouldUseDarkColors: false },
  screen: {}, shell: {},
}));
let spawns = 0;
spyOn(childProcess, "spawn").mockImplementation((() => {
    spawns++;
    const child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
      stderr: Object.assign(new EventEmitter(), { setEncoding() {} }),
      kill() {}, killed: false,
    });
    queueMicrotask(() => child.stdout.emit("data", "METAHUB_PORT=12345\n"));
    return child;
}) as unknown as typeof childProcess.spawn);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const macOpen = (url: string) => app.emit("open-url", { preventDefault() {} }, url);
const forwardedOpen = (url: string) => app.emit("second-instance", {}, ["Metahub", url, "--flag"], profile);
const mainWindows = () => Window.all.filter((w) => !w.destroyed && w.options.width === 1280);

if (scenario === "argv" || scenario === "secondary" || scenario === "booting") process.argv.push("mh://doc/doc_cold-123", "--flag");
await import("../preload.ts");
await import("../main.ts");
if (scenario === "mac") macOpen("mh://doc/doc_cold-123");
ready();
await flush();
if (scenario === "secondary") {
  assert.equal(quit, true);
  assert.equal(spawns, 0);
  assert.deepEqual(registrations, []);
  process.exit(0);
}
assert.deepEqual(registrations, scenario === "dev" ? [] : ["mh"]);
assert.equal(spawns, 1);
assert.equal(mainWindows().length, 0, "must wait for sidecar health");
if (scenario === "booting") {
  forwardedOpen("mh://doc/doc_older-123");
  macOpen("mh://doc/doc_latest-123");
}
healthy(new Response('{"ok":true}'));
await flush();
let win = mainWindows()[0]!;
assert.ok(win, "creates a main window after health");
const received: string[] = [];
if (scenario === "mac" || scenario === "argv") {
  assert.equal(win.url, "http://127.0.0.1:12345/#/doc/doc_cold-123");
  win.finish();
  bridge.onOpenDoc((id: string) => received.push(id));
  assert.deepEqual(received, ["doc_cold-123"]);
} else if (scenario === "booting") {
  assert.equal(win.url, "http://127.0.0.1:12345/#/doc/doc_latest-123");
  win.finish();
  bridge.onOpenDoc((id: string) => received.push(id));
  assert.deepEqual(received, ["doc_latest-123"]);
} else if (scenario === "loading") {
  forwardedOpen("mh://doc/doc_older-123");
  macOpen("mh://doc/doc_latest-123");
  assert.equal(mainWindows().length, 1);
  win.finish();
  bridge.onOpenDoc((id: string) => received.push(id));
  assert.deepEqual(received, ["doc_latest-123"]);
} else if (scenario === "closed") {
  win.close();
  macOpen("mh://doc/doc_reopened-123");
  assert.equal(mainWindows().length, 1);
  win = mainWindows()[0]!;
  assert.equal(win.url, "http://127.0.0.1:12345/#/doc/doc_reopened-123");
  win.finish();
  bridge.onOpenDoc((id: string) => received.push(id));
  assert.deepEqual(received, ["doc_reopened-123"]);
} else {
  win.finish();
  bridge.onOpenDoc((id: string) => received.push(id));
  win.minimized = true;
  forwardedOpen("mh://doc/doc_warm-123");
  macOpen("mh://document/open?id=doc_another-123");
  macOpen("mh://doc/../../etc/passwd");
  assert.deepEqual(received, ["doc_warm-123", "doc_another-123"]);
  assert.equal(win.minimized, false);
  assert.equal(win.shown && win.focused, true);
  assert.equal(mainWindows().length, 1);
}
assert.equal(spawns, 1, "external URLs reuse the existing sidecar");
process.exit(0);
