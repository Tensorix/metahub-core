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
  nativeTheme,
  screen,
  Tray,
} from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cachedBinaryPath,
  fetchLatestCoreRelease,
  getInstalledCoreVersion,
  maybeUpdateCore,
} from "./core-updater";
import { tagToVersion } from "./version-util";

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
let mainWin: BrowserWindow | null = null;
let splashWin: BrowserWindow | null = null;
let quickWin: BrowserWindow | null = null;
let quickReady = false; // has the quick-note window painted at least once?
let quickPendingShow = false; // reveal the quick-note window as soon as it paints
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

/** The compiled sidecar binary name shipped as an extraResource. */
function sidecarBinaryName(): string {
  return process.platform === "win32" ? "metahub-sidecar.exe" : "metahub-sidecar";
}

/**
 * Pick the packaged sidecar binary: prefer the auto-updated copy in the
 * user-data cache (written by core-updater on a prior launch), falling back to
 * the one bundled in Resources/. This is what gives us "core updates without
 * repackaging the app" — see core-updater.ts.
 */
function packagedSidecarPath(): string {
  const cached = cachedBinaryPath();
  if (existsSync(cached)) {
    try {
      accessSync(cached, constants.X_OK);
      return cached;
    } catch {
      /* not executable — fall back to the bundled copy */
    }
  }
  return join(process.resourcesPath, sidecarBinaryName());
}

/**
 * Resolve how to launch the sidecar.
 *  - packaged: run the self-contained compiled binary (cached update, else the
 *    one bundled in Resources/). No Bun on PATH, no source tree needed.
 *  - dev: `bun run src/server-entry.ts` from source (WebUI builds lazily).
 */
function resolveSidecarCommand(): { cmd: string; args: string[] } {
  if (app.isPackaged) {
    return { cmd: packagedSidecarPath(), args: [] };
  }
  return { cmd: resolveBun(), args: ["run", appFile("src", "server-entry.ts")] };
}

/** Spawn the Bun sidecar and resolve with the port it prints on stdout. */
function startSidecar(): Promise<number> {
  const { cmd, args } = resolveSidecarCommand();

  return new Promise<number>((resolve, reject) => {
    const child = spawn(cmd, args, {
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

    child.on("error", (err) => fail(new Error(`failed to launch sidecar (${cmd}): ${err.message}`)));
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

/**
 * Show a tiny branded splash immediately at startup. It covers the whole cold
 * start — sidecar spawn, /health poll, and the WebUI's first paint — so the
 * user never stares at a blank/white window. It is self-contained (no sidecar,
 * no CDN) so it paints instantly; see apps/desktop/assets/splash.html.
 */
function createSplash(): void {
  const win = new BrowserWindow({
    width: 360,
    height: 240,
    frame: false,
    resizable: false,
    movable: true,
    center: true,
    show: false,
    skipTaskbar: true,
    title: "Metahub",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1a1c" : "#ffffff",
  });
  splashWin = win;
  win.on("closed", () => {
    if (splashWin === win) splashWin = null;
  });
  win.once("ready-to-show", () => win.show());
  void win.loadFile(appFile("assets", "splash.html"));
}

function closeSplash(): void {
  if (splashWin && !splashWin.isDestroyed()) splashWin.close();
  splashWin = null;
}

function createWindow(port: number): void {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 720,
    minHeight: 480,
    title: "Metahub",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1a1c" : "#ffffff",
    // Stay hidden until the renderer has painted its first frame, then reveal
    // and hand off from the splash — no white flash, no blank window.
    show: false,
    // macOS: hide the native title bar but keep the inset traffic lights; the
    // WebUI reserves space for them and defines its own drag regions. Other
    // platforms keep the default native frame.
    ...(isMac
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 17 } }
      : {}),
    webPreferences: {
      preload: appFile("dist", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin = win;
  win.on("closed", () => {
    if (mainWin === win) mainWin = null;
  });
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
    closeSplash();
    // Main window is up; quietly warm the quick-note window in the background
    // so its first open is instant. Deferred so it never competes with the
    // main window's first frame.
    setTimeout(prewarmQuickNote, 0);
    // Check for a newer core sidecar in the background; if found it's cached and
    // used on the NEXT launch (never hot-swapping the running one). Errors are
    // swallowed inside maybeUpdateCore — this must never disrupt the app.
    if (app.isPackaged) setTimeout(() => void maybeUpdateCore(), 3_000);
  });
  void win.loadURL(`http://127.0.0.1:${port}/`);
}

/**
 * Bring the main window to the front, creating it if it was closed.
 * Used by the macOS dock-icon `activate` handler. Note: a hidden Quick Note
 * window keeps `getAllWindows()` non-empty, so we track the main window
 * explicitly rather than counting windows.
 */
function showMainWindow(): void {
  if (!mainWin || mainWin.isDestroyed()) {
    createWindow(serverPort);
    return;
  }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
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
          // panel: non-activating NSPanel mask at runtime, so the window floats
          // over other apps' full-screen spaces and joins all spaces WITHOUT
          // activating Metahub (no jump back to the main window's desktop). The
          // main app keeps its dock icon — only this window behaves like a panel.
          type: "panel" as const,
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

  if (isMac) {
    // screen-saver level floats above full-screened apps; visibleOnFullScreen +
    // skipTransformProcessType keeps it on every space without the brief dock
    // flicker that the default process-type transform would cause.
    win.setAlwaysOnTop(settings.alwaysOnTop, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  }

  quickReady = false;
  void win.loadURL(`http://127.0.0.1:${serverPort}/#quick`);
  // Decouple create from show: ready-to-show only reveals the window if a show
  // was actually requested. This lets us pre-warm it hidden at startup (render
  // in the background) without it popping up — the first real open is instant.
  win.once("ready-to-show", () => {
    quickReady = true;
    if (quickPendingShow && !win.isDestroyed()) revealQuickNote(win);
  });

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
      quickPendingShow = false;
      win.hide();
    }
  });
  win.on("closed", () => {
    if (quickWin === win) {
      quickWin = null;
      quickReady = false;
    }
  });

  return win;
}

/** Reveal the (already-rendered) quick-note window. */
function revealQuickNote(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Create the quick-note window hidden and let it render in the background, so
 * the first shortcut/tray open reveals an already-painted window with no white
 * flash. Called once the main window is up; a cheap no-op if already warm.
 */
function prewarmQuickNote(): void {
  if (!quickWin || quickWin.isDestroyed()) quickWin = createQuickNoteWindow();
}

function showQuickNote(): void {
  if (!quickWin || quickWin.isDestroyed()) quickWin = createQuickNoteWindow();
  quickPendingShow = true;
  // Pre-warmed at startup → already painted → reveal instantly. If the user is
  // fast enough to beat first paint, the ready-to-show handler reveals it then.
  if (quickReady) revealQuickNote(quickWin);
}

function toggleQuickNote(): void {
  if (quickWin && !quickWin.isDestroyed() && quickWin.isVisible() && quickWin.isFocused()) {
    quickPendingShow = false;
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
  ipcMain.handle("app:get-version", () => app.getVersion());

  // Core sidecar update (desktop-only; the WebUI's "软件更新" settings section).
  // `installed` is the version staged on disk (version.json) — what the NEXT
  // launch will run; compared against the running core (/api/version) it tells
  // the UI whether an already-downloaded update is waiting for a restart.
  ipcMain.handle("core:installed-version", () => getInstalledCoreVersion());
  ipcMain.handle("core:check", async () => {
    const release = await fetchLatestCoreRelease();
    return { latest: release ? tagToVersion(release.tag_name) : null };
  });
  // Reuses the startup auto-updater: fetch latest, compare vs staged, download +
  // verify + stage. Returns the staged version, or null if nothing newer.
  ipcMain.handle("core:download", () => maybeUpdateCore());
  ipcMain.handle("core:restart", () => {
    app.relaunch();
    app.quit();
  });

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
    if (quickWin && !quickWin.isDestroyed()) {
      // screen-saver level on macOS so the toggle keeps the window above
      // full-screened apps, matching the panel's cross-space behavior.
      quickWin.setAlwaysOnTop(on, process.platform === "darwin" ? "screen-saver" : "normal");
    }
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
  // Branded feedback up front, before any slow startup work begins.
  createSplash();
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

    // macOS: re-open / focus the main window when the dock icon is clicked.
    app.on("activate", () => showMainWindow());
  } catch (err) {
    closeSplash();
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
