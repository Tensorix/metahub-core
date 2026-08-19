/**
 * Preload script. The WebUI talks to the sidecar over HTTP, so it needs almost
 * no IPC. We expose a tiny, read-only environment surface plus the `quicknote`
 * bridge the Quick Notes window and the settings page use to drive the native
 * global shortcut / always-on-top behaviour (see src/webui/desktop.d.ts).
 */
import { contextBridge, ipcRenderer } from "electron";

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
  },
  quickboard: {
    getSettings: () => ipcRenderer.invoke("qb:get-settings"),
    setShortcut: (accelerator: string) => ipcRenderer.invoke("qb:set-shortcut", accelerator),
    getAlwaysOnTop: () => ipcRenderer.invoke("qb:get-always-on-top"),
    setAlwaysOnTop: (on: boolean) => ipcRenderer.invoke("qb:set-always-on-top", on),
    hide: () => ipcRenderer.invoke("qb:hide"),
  },
  preview: {
    open: (p: { src: string; name?: string; blockId: string }) => ipcRenderer.invoke("preview:open", p),
  },
  file: {
    read: (path: string) => ipcRenderer.invoke("file:read", path),
    write: (path: string, text: string) => ipcRenderer.invoke("file:write", path, text),
    setDirty: (path: string, dirty: boolean) => ipcRenderer.invoke("file:set-dirty", path, dirty),
    saveDone: () => ipcRenderer.invoke("file:save-done"),
    focusMain: () => ipcRenderer.invoke("file:focus-main"),
    onRequestSave: (cb: () => void) => {
      const l = () => cb();
      ipcRenderer.on("file:request-save", l);
      return () => ipcRenderer.removeListener("file:request-save", l);
    },
  },
  oauth: {
    // Open a Cloudflare consent URL in the system browser (main-process validated).
    openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke("oauth:open-external", url),
  },
});
