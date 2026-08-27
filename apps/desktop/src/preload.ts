/**
 * Preload script. The WebUI talks to the sidecar over HTTP, so it needs almost
 * no IPC. We expose a tiny, read-only environment surface plus the `quicknote`
 * bridge the Quick Notes window and the settings page use to drive the native
 * global shortcut / always-on-top behaviour (see src/webui/desktop.d.ts).
 */
import { contextBridge, ipcRenderer } from "electron";

// File-editor windows get their path via additionalArguments; read the content
// synchronously HERE, before any page script runs, so the renderer's first
// render already has the text (no 加载中 state). Path only in argv — content
// travels over the allowlisted sync IPC (file:read-sync in main.ts).
const preloadStart = Date.now();
const openFileArg = process.argv.find((a) => a.startsWith("--mh-open-file="));
let initialFile: { path: string; text: string; name: string } | null = null;
let syncReadMs = -1;
if (openFileArg) {
  const p = openFileArg.slice("--mh-open-file=".length);
  try {
    const t = Date.now();
    initialFile = ipcRenderer.sendSync("file:read-sync", p) ?? null;
    syncReadMs = Date.now() - t;
  } catch {
    initialFile = null; // fall back to the async read in file-editor.tsx
  }
}

// Renderer paint milestones → the main process's [perf] log (numbers are
// relative to this renderer's timeOrigin). Sent once FCP is observed, or on a
// timeout fallback for pages that never paint contentful frames.
window.addEventListener("load", () => {
  let sent = false;
  const send = () => {
    if (sent) return;
    sent = true;
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    const paints = Object.fromEntries(
      performance.getEntriesByType("paint").map((p) => [p.name, Math.round(p.startTime)]),
    );
    ipcRenderer.send("perf:renderer", {
      dcl: nav ? Math.round(nav.domContentLoadedEventStart) : -1,
      load: nav ? Math.round(nav.loadEventStart) : -1,
      fp: paints["first-paint"] ?? -1,
      fcp: paints["first-contentful-paint"] ?? -1,
      preloadMs: Date.now() - preloadStart,
      syncReadMs,
    });
  };
  try {
    const po = new PerformanceObserver(() => {
      if (performance.getEntriesByType("paint").some((p) => p.name === "first-contentful-paint")) {
        send();
        po.disconnect();
      }
    });
    po.observe({ type: "paint", buffered: true });
  } catch {
    /* paint timing unsupported — timeout fallback below */
  }
  setTimeout(send, 3000);
});

contextBridge.exposeInMainWorld("metahubDesktop", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  appVersion: () => ipcRenderer.invoke("app:get-version"),
  coreUpdate: {
    installedVersion: () => ipcRenderer.invoke("core:installed-version"),
    check: () => ipcRenderer.invoke("core:check"),
    download: () => ipcRenderer.invoke("core:download"),
    restart: () => ipcRenderer.invoke("core:restart"),
    onDownloadProgress: (cb: (p: { received: number; total: number }) => void) => {
      const l = (_e: unknown, p: { received: number; total: number }) => cb(p);
      ipcRenderer.on("core:download-progress", l);
      return () => ipcRenderer.removeListener("core:download-progress", l);
    },
  },
  quicknote: {
    getSettings: () => ipcRenderer.invoke("qn:get-settings"),
    setShortcut: (accelerator: string) => ipcRenderer.invoke("qn:set-shortcut", accelerator),
    getAlwaysOnTop: () => ipcRenderer.invoke("qn:get-always-on-top"),
    setAlwaysOnTop: (on: boolean) => ipcRenderer.invoke("qn:set-always-on-top", on),
    hide: () => ipcRenderer.invoke("qn:hide"),
    show: () => ipcRenderer.invoke("qn:show"),
    openMain: (hash: string) => ipcRenderer.invoke("main:open-at", hash),
  },
  quickboard: {
    getSettings: () => ipcRenderer.invoke("qb:get-settings"),
    setShortcut: (accelerator: string) => ipcRenderer.invoke("qb:set-shortcut", accelerator),
    getAlwaysOnTop: () => ipcRenderer.invoke("qb:get-always-on-top"),
    setAlwaysOnTop: (on: boolean) => ipcRenderer.invoke("qb:set-always-on-top", on),
    hide: () => ipcRenderer.invoke("qb:hide"),
    show: () => ipcRenderer.invoke("qb:show"),
    openMain: (hash: string) => ipcRenderer.invoke("main:open-at", hash),
  },
  preview: {
    open: (p: { src: string; name?: string; blockId: string }) => ipcRenderer.invoke("preview:open", p),
  },
  file: {
    read: (path: string) => ipcRenderer.invoke("file:read", path),
    write: (path: string, text: string) => ipcRenderer.invoke("file:write", path, text),
    setDirty: (path: string, dirty: boolean) => ipcRenderer.invoke("file:set-dirty", path, dirty),
    saveDone: (result?: { ok: boolean; error?: string }) =>
      ipcRenderer.invoke("file:save-done", result),
    focusMain: (docId?: string) => ipcRenderer.invoke("file:focus-main", docId),
    onRequestSave: (cb: () => void) => {
      const l = () => cb();
      ipcRenderer.on("file:request-save", l);
      return () => ipcRenderer.removeListener("file:request-save", l);
    },
    initial: initialFile,
  },
  server: {
    // Resolves once the sidecar is healthy — lets the disk-loaded file-editor
    // window attach API-dependent features late instead of waiting to open.
    origin: () => ipcRenderer.invoke("server:origin"),
  },
  // Main window: deep-link a doc pushed from the main process (file-editor
  // 「在 MetaHub 中打开」 across the file://→http origin gap).
  onOpenDoc: (cb: (id: string) => void) => {
    const l = (_e: unknown, p: { id?: string }) => {
      if (p?.id) cb(p.id);
    };
    ipcRenderer.on("mh:open-doc", l);
    return () => ipcRenderer.removeListener("mh:open-doc", l);
  },
  oauth: {
    // Open a Cloudflare consent URL in the system browser (main-process validated).
    openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke("oauth:open-external", url),
  },
});
