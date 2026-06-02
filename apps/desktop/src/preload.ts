/**
 * Preload script. The WebUI talks to the sidecar over HTTP, so it needs no IPC.
 * We expose only a tiny, read-only surface for environment awareness.
 */
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("metahubDesktop", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
