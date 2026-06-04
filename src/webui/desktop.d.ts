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
  quicknote?: {
    getSettings: () => Promise<QuickNoteSettings>;
    setShortcut: (accelerator: string) => Promise<QuickNoteSettings>;
    getAlwaysOnTop: () => Promise<boolean>;
    setAlwaysOnTop: (on: boolean) => Promise<boolean>;
    hide: () => Promise<void>;
  };
}

declare global {
  interface Window {
    metahubDesktop?: MetahubDesktop;
  }
}
