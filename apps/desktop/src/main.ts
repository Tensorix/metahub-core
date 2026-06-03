/**
 * Electron main process for the Metahub desktop app.
 *
 * Runs on Electron's bundled Node runtime. It spawns the Bun sidecar
 * (server-entry.ts) which starts the real metahub server, discovers the
 * sidecar's port from stdout, waits for /health, then loads the embedded
 * WebUI in a BrowserWindow. No core logic lives here — this is just a shell.
 *
 * It also hosts the Quick Notes window: a small, optionally-translucent,
 * always-on-top markdown window summoned by a global shortcut or the tray
 * icon. It loads the same WebUI bundle at `…/#quick` (see src/webui/app.tsx).
 * Shortcut / always-on-top / window bounds are persisted locally as JSON.
 */
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
} from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HEALTH_PATH = "/health"; // mirrors src/core/sync/protocol.ts
const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_INTERVAL_MS = 150;

const DEFAULT_SHORTCUT = "CommandOrControl+Shift+Space";

/**
 * Resolve a path inside the app bundle. NOTE: do not use `__dirname` here —
 * `bun build` inlines it to the *source* dir (apps/desktop/src) at build time,
 * so `join(__dirname, "preload.js")` would point at a nonexistent file and the
 * preload would silently fail to load (no window.metahubDesktop bridge).
 * `app.getAppPath()` is the real app root (apps/desktop) at runtime.
 */
function appFile(...segments: string[]): string {
  return join(app.getAppPath(), ...segments);
}

interface QuickNoteSettings {
  shortcut: string;
  alwaysOnTop: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}

let sidecar: ChildProcess | null = null;
let serverPort = 0;
let quickWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let currentShortcut: string | null = null;
let quitting = false;
let settings: QuickNoteSettings = { shortcut: DEFAULT_SHORTCUT, alwaysOnTop: false };

// ---- persisted quick-note settings ----------------------------------------

function settingsPath(): string {
  return join(app.getPath("userData"), "quicknote-settings.json");
}

function loadSettings(): void {
  try {
    const raw = readFileSync(settingsPath(), "utf8");
    settings = { ...settings, ...(JSON.parse(raw) as QuickNoteSettings) };
  } catch {
    // first run / unreadable — keep defaults
  }
  if (!settings.shortcut) settings.shortcut = DEFAULT_SHORTCUT;
}

function saveSettings(): void {
  try {
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error("[quicknote] failed to save settings:", (err as Error).message);
  }
}

// ---- sidecar ---------------------------------------------------------------

/** Locate a Bun executable: explicit override, PATH, then common install dirs. */
function resolveBun(): string {
  if (process.env.BUN_PATH) return process.env.BUN_PATH;
  for (const p of ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"]) {
    if (existsSync(p)) return p;
  }
  return "bun"; // rely on PATH (dev is launched from a shell that has bun)
}

/** Spawn the Bun sidecar and resolve with the port it prints on stdout. */
function startSidecar(): Promise<number> {
  // dist/main.js → ../src/server-entry.ts (server-entry stays uncompiled .ts)
  const entry = appFile("src", "server-entry.ts");
  const bun = resolveBun();

  return new Promise<number>((resolve, reject) => {
    const child = spawn(bun, ["run", entry], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    sidecar = child;

    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      process.stdout.write(`[sidecar] ${chunk}`);
      const m = chunk.match(/METAHUB_PORT=(\d+)/);
      if (m && !settled) {
        settled = true;
        resolve(Number(m[1]));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => process.stderr.write(`[sidecar] ${chunk}`));

    child.on("error", (err) => fail(new Error(`failed to launch Bun (${bun}): ${err.message}`)));
    child.on("exit", (code) => fail(new Error(`sidecar exited early (code ${code})`)));
  });
}

/** Poll /health until the server answers ok, or time out. */
async function waitForHealth(port: number): Promise<void> {
  const url = `http://127.0.0.1:${port}${HEALTH_PATH}`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean };
        if (body.ok) return;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
  throw new Error(`server did not become healthy within ${HEALTH_TIMEOUT_MS}ms`);
}

// ---- windows ---------------------------------------------------------------

function createWindow(port: number): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 720,
    minHeight: 480,
    title: "Metahub",
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: appFile("dist", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void win.loadURL(`http://127.0.0.1:${port}/`);
}

/** Default bottom-right placement on the primary display's work area. */
function defaultQuickBounds(): { x: number; y: number; width: number; height: number } {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 420;
  const height = 560;
  const margin = 24;
  return {
    width,
    height,
    x: workArea.x + workArea.width - width - margin,
    y: workArea.y + workArea.height - height - margin,
  };
}

function createQuickNoteWindow(): BrowserWindow {
  const isMac = process.platform === "darwin";
  const bounds = settings.bounds ?? defaultQuickBounds();

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 280,
    minHeight: 240,
    title: "快速笔记",
    show: false,
    resizable: true,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: true,
    fullscreenable: false,
    // macOS: translucent vibrancy with a hidden-inset title bar (traffic lights
    // float over the draggable top bar). Other platforms: a plain frameless window.
    ...(isMac
      ? {
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const,
          backgroundColor: "#00000000",
          titleBarStyle: "hiddenInset" as const,
        }
      : { frame: false, backgroundColor: "#ffffff" }),
    webPreferences: {
      preload: appFile("dist", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void win.loadURL(`http://127.0.0.1:${serverPort}/#quick`);
  win.once("ready-to-show", () => win.show());

  const persistBounds = debounce(() => {
    if (!win.isDestroyed()) {
      settings.bounds = win.getBounds();
      saveSettings();
    }
  }, 400);
  win.on("resize", persistBounds);
  win.on("move", persistBounds);

  // Closing just hides — the window stays warm for an instant reopen. It is
  // really destroyed only when the whole app is quitting.
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    if (quickWin === win) quickWin = null;
  });

  return win;
}

function showQuickNote(): void {
  if (!quickWin || quickWin.isDestroyed()) quickWin = createQuickNoteWindow();
  quickWin.show();
  quickWin.focus();
}

function toggleQuickNote(): void {
  if (quickWin && !quickWin.isDestroyed() && quickWin.isVisible() && quickWin.isFocused()) {
    quickWin.hide();
  } else {
    showQuickNote();
  }
}

// ---- global shortcut -------------------------------------------------------

/** Register `accel`, replacing any previous registration. Returns success. */
function registerShortcut(accel: string): boolean {
  if (currentShortcut) {
    globalShortcut.unregister(currentShortcut);
    currentShortcut = null;
  }
  let ok = false;
  try {
    ok = globalShortcut.register(accel, toggleQuickNote);
  } catch {
    ok = false;
  }
  if (ok) currentShortcut = accel;
  return ok;
}

// ---- tray ------------------------------------------------------------------

function createTray(): void {
  const iconPath = appFile("assets", "trayTemplate.png");
  const image = nativeImage.createFromPath(iconPath);
  if (process.platform === "darwin") image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("Metahub 快速笔记");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "快速笔记", click: () => showQuickNote() },
      { type: "separator" },
      { label: "退出 Metahub", click: () => app.quit() },
    ]),
  );
  // Left-click toggles (context menu still available via right-click).
  tray.on("click", () => toggleQuickNote());
}

// ---- IPC (preload bridge) --------------------------------------------------

function registerIpc(): void {
  ipcMain.handle("qn:get-settings", () => ({
    shortcut: settings.shortcut,
    alwaysOnTop: settings.alwaysOnTop,
  }));

  ipcMain.handle("qn:set-shortcut", (_e, accel: string) => {
    const prev = currentShortcut;
    if (!registerShortcut(accel)) {
      if (prev) registerShortcut(prev); // restore the working binding
      throw new Error(`快捷键「${accel}」无法注册（可能被占用）`);
    }
    settings.shortcut = accel;
    saveSettings();
    return { shortcut: settings.shortcut, alwaysOnTop: settings.alwaysOnTop };
  });

  ipcMain.handle("qn:get-always-on-top", () =>
    quickWin && !quickWin.isDestroyed() ? quickWin.isAlwaysOnTop() : settings.alwaysOnTop,
  );

  ipcMain.handle("qn:set-always-on-top", (_e, on: boolean) => {
    settings.alwaysOnTop = on;
    if (quickWin && !quickWin.isDestroyed()) quickWin.setAlwaysOnTop(on);
    saveSettings();
    return on;
  });

  ipcMain.handle("qn:hide", () => {
    if (quickWin && !quickWin.isDestroyed()) quickWin.hide();
  });
}

// ---- helpers ---------------------------------------------------------------

function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

function killSidecar(): void {
  if (sidecar && !sidecar.killed) sidecar.kill();
  sidecar = null;
}

// ---- lifecycle -------------------------------------------------------------

app.whenReady().then(async () => {
  loadSettings();
  try {
    serverPort = await startSidecar();
    await waitForHealth(serverPort);
    registerIpc();
    createWindow(serverPort);
    createTray();

    if (!registerShortcut(settings.shortcut) && settings.shortcut !== DEFAULT_SHORTCUT) {
      // Fall back to the default if a persisted custom shortcut is unavailable.
      registerShortcut(DEFAULT_SHORTCUT);
      settings.shortcut = DEFAULT_SHORTCUT;
      saveSettings();
    }

    // macOS: re-open the main window when the dock icon is clicked.
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(serverPort);
    });
  } catch (err) {
    killSidecar();
    dialog.showErrorBox("Metahub failed to start", (err as Error).message);
    app.quit();
  }
});

// The Quick Notes window and tray mean the app intentionally outlives all
// regular windows; do not quit on window-all-closed (even off macOS).
app.on("window-all-closed", () => {
  // no-op: tray + global shortcut keep the app alive
});

app.on("before-quit", () => {
  quitting = true;
  globalShortcut.unregisterAll();
  killSidecar();
});
app.on("will-quit", killSidecar);
process.on("exit", killSidecar);
