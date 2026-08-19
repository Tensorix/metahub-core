// Shape of the bridge the Electron preload exposes on `window.metahubDesktop`.
// Present only inside the desktop app; guard with `window.metahubDesktop?.…`
// in the browser WebUI. The `quicknote` surface drives the Quick Notes window
// (global shortcut + always-on-top), persisted by the Electron main process.

export interface QuickNoteSettings {
  shortcut: string;
  alwaysOnTop: boolean;
}

export interface MetahubDesktop {
  platform: NodeJS.Platform;
  versions: { electron: string; chrome: string; node: string };
  /** Electron shell (desktop app) version, from the main process. */
  appVersion?: () => Promise<string>;
  /**
   * Core sidecar auto-update bridge. `installedVersion` is the version staged on
   * disk (runs next launch); `check` hits GitHub for the latest release without
   * downloading — `latest: null` means the lookup FAILED (offline/rate-limited),
   * not "no update"; `download` downloads+verifies+stages it (returns the staged
   * version, or null if nothing newer); `restart` relaunches to apply a staged
   * core. Present only in the desktop app.
   */
  coreUpdate?: {
    installedVersion: () => Promise<string>;
    check: () => Promise<{ latest: string | null }>;
    download: () => Promise<string | null>;
    restart: () => Promise<void>;
    /**
     * Subscribe to download progress while `download()` runs. `total` is 0 when
     * the server sent no Content-Length (render an indeterminate bar). Returns an
     * unsubscribe fn. Optional — absent on older preload builds.
     */
    onDownloadProgress?: (cb: (p: { received: number; total: number }) => void) => () => void;
  };
  quicknote?: {
    getSettings: () => Promise<QuickNoteSettings>;
    setShortcut: (accelerator: string) => Promise<QuickNoteSettings>;
    getAlwaysOnTop: () => Promise<boolean>;
    setAlwaysOnTop: (on: boolean) => Promise<boolean>;
    hide: () => Promise<void>;
  };
  /** Same surface for the Quick Board window ("qb:*" IPC). Absent on older
   *  Electron shells (the core auto-updater refreshes the webui without
   *  repackaging the shell) — feature-detect before use. */
  quickboard?: {
    getSettings: () => Promise<QuickNoteSettings>;
    setShortcut: (accelerator: string) => Promise<QuickNoteSettings>;
    getAlwaysOnTop: () => Promise<boolean>;
    setAlwaysOnTop: (on: boolean) => Promise<boolean>;
    hide: () => Promise<void>;
  };
  /** Open the image preview in a frameless native window (vs the in-page lightbox
   *  in a browser). The window flattens+re-uploads annotations itself and reports
   *  the new /blob URL back over BroadcastChannel("mh-doc-image"). */
  preview?: {
    open: (p: { src: string; name?: string; blockId: string }) => Promise<void>;
  };
  /** Open a Cloudflare OAuth consent URL in the system browser (the loopback
   *  redirect is caught by the Bun sidecar). Main-process validated to the
   *  Cloudflare dash host. Returns false if the URL was rejected. */
  oauth?: {
    openExternal: (url: string) => Promise<boolean>;
  };
  /**
   * File-editor window bridge (the .txt/.md "open with" feature). read/write
   * are restricted by the main process to paths it opened itself (file
   * association / argv / open-file) — arbitrary paths reject. `setDirty` drives
   * the native unsaved-changes state (macOS close-button dot + close-confirm);
   * `onRequestSave` fires when the user picks 保存 in that confirm — write the
   * file, then call `saveDone` so the window may close. `focusMain` raises the
   * main window (used after 导入到 MetaHub).
   */
  file?: {
    read: (path: string) => Promise<{ text: string; name: string }>;
    write: (path: string, text: string) => Promise<void>;
    setDirty: (path: string, dirty: boolean) => Promise<void>;
    saveDone: () => Promise<void>;
    focusMain: () => Promise<void>;
    onRequestSave: (cb: () => void) => () => void;
  };
}

declare global {
  interface Window {
    metahubDesktop?: MetahubDesktop;
  }
}
