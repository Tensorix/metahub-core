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
 *
 * And the file-editor windows: Metahub registers as an "open with" handler for
 * .txt/.md (electron-builder fileAssociations); opened files get a standalone
 * editor window at `…/#file?path=…` with an 导入到 MetaHub button. File I/O
 * stays in this process (file: IPC, path-allowlisted).
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
  shell,
  Tray,
} from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  cachedBinaryPath,
  fetchLatestCoreRelease,
  getInstalledCoreVersion,
  maybeUpdateCore,
} from "./core-updater";
import {
  quarantineLegacyServiceWorkerStorage,
  removeQuarantinedServiceWorkerStorage,
} from "./service-worker-cleanup";
import { tagToVersion } from "./version-util";

const HEALTH_PATH = "/health"; // mirrors src/core/sync/protocol.ts
const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_INTERVAL_MS = 150;

const DEFAULT_NOTE_SHORTCUT = "CommandOrControl+Shift+Space";
const DEFAULT_BOARD_SHORTCUT = "CommandOrControl+Shift+B";

// Test-only isolation: point userData at a scratch dir so a second instance
// (integration debugging against a scratch METAHUB_HOME) never touches the
// real profile. No effect unless the env var is set.
if (process.env.MH_TEST_USER_DATA) app.setPath("userData", process.env.MH_TEST_USER_DATA);

// Older desktop releases registered a Service Worker for every random sidecar
// port. Those origins share this Electron profile but cannot be enumerated from
// the current renderer, eventually leaving Chromium with a large/corrupt
// Service Worker database. Detach it before Chromium opens the profile; removal
// happens in the background once the app is ready.
const legacyServiceWorkerCleanup = quarantineLegacyServiceWorkerStorage(app.getPath("userData"));
if (legacyServiceWorkerCleanup.warning) {
  console.warn(
    "[desktop] could not detach legacy Service Worker storage:",
    legacyServiceWorkerCleanup.warning,
  );
}

// Single instance: a Win/Linux "打开方式" launch spawns a second process; forward
// its file args to the running instance instead of booting a second sidecar /
// tray / shortcut. The lock is scoped to userData, so an MH_TEST_USER_DATA
// scratch instance (redirected above) still coexists with the real app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv, workingDirectory) => {
    // Relative paths in the forwarded argv are relative to the SECOND
    // instance's cwd — resolve against it, not our own.
    const files = fileArgsFrom(argv, workingDirectory);
    if (files.length > 0) files.forEach(queueOpenFile);
    else showMainWindow();
  });
}

// macOS file-association / dock-drop opens. Fires before app.whenReady() for
// launch-time opens, so this must be registered at module scope; paths queue
// until the sidecar is healthy (drained at the end of startup).
app.on("open-file", (e, path) => {
  e.preventDefault();
  queueOpenFile(path);
});

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

let sidecar: ChildProcess | null = null;
let serverPort = 0;
let mainWin: BrowserWindow | null = null;
let splashWin: BrowserWindow | null = null;
let previewWin: BrowserWindow | null = null;
// File-editor windows (the .txt/.md "open with" feature), one per absolute path.
const fileWins = new Map<string, BrowserWindow>();
const fileDirty = new Map<string, boolean>();
// Paths the app itself opened (file association / argv / open-file). The
// file:read/write IPC only accepts paths from this set, so a renderer can
// never reach arbitrary files on disk.
const allowedFilePaths = new Set<string>();
// open-file fires before the sidecar port is known — queue and drain later.
const pendingOpenFiles: string[] = [];
// close-flow "保存" waits for the renderer's file:save-done, keyed by WebContents id.
const saveWaiters = new Map<number, () => void>();
// Windows whose dirty-confirm dialog already ran; close() proceeds unprompted.
const forceClosing = new WeakSet<BrowserWindow>();
let tray: Tray | null = null;
let quitting = false;

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

/**
 * Route target="_blank" links to the system browser. Without this Electron
 * opens a bare chrome-less child window for every external link the WebUI
 * renders (关于 page resources, site/share URLs). Only web URLs escape; anything
 * else is denied.
 */
function routeExternalLinks(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
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
  routeExternalLinks(win);
  win.on("closed", () => {
    if (mainWin === win) mainWin = null;
  });
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
    closeSplash();
    // Main window is up; quietly warm the mini windows in the background so
    // their first open is instant. Deferred so they never compete with the
    // main window's first frame (the board trails the note by a second).
    setTimeout(() => quickNote.prewarm(), 0);
    setTimeout(() => quickBoard.prewarm(), 1000);
    // Check for a newer core sidecar in the background; if found it's cached and
    // used on the NEXT launch (never hot-swapping the running one). Errors are
    // swallowed inside maybeUpdateCore — this must never disrupt the app.
    if (app.isPackaged) setTimeout(() => void maybeUpdateCore(), 3_000);
  });
  void win.loadURL(`http://127.0.0.1:${port}/`);
}

/**
 * Open (or reuse) the frameless image-preview window. Loads the same WebUI at
 * `…/#preview?…` so it's same-origin with the editor — it shares the auth token
 * and blob bytes, flattens+uploads annotations itself, and posts the new /blob URL
 * back to the editor over BroadcastChannel. No top bar on any platform.
 */
function openPreview(p: { src: string; name?: string; blockId: string }): void {
  if (!serverPort) return;
  const isMac = process.platform === "darwin";
  const params = new URLSearchParams({ src: p.src, bid: p.blockId });
  if (p.name) params.set("name", p.name);
  const url = `http://127.0.0.1:${serverPort}/#preview?${params.toString()}`;
  if (previewWin && !previewWin.isDestroyed()) {
    void previewWin.loadURL(url);
    previewWin.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 480,
    minHeight: 360,
    title: p.name || "图片预览",
    frame: false, // no top bar on any platform
    show: false,
    // macOS: translucent "popover" vibrancy behind a transparent window (the WebUI
    // tints it for image contrast — see body.preview-window.desktop-mac). Other
    // platforms get a plain opaque dark frameless window.
    ...(isMac
      ? { vibrancy: "popover" as const, visualEffectState: "active" as const, backgroundColor: "#00000000" }
      : { backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1a1c" : "#ffffff" }),
    webPreferences: {
      preload: appFile("dist", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  previewWin = win;
  routeExternalLinks(win);
  win.on("closed", () => {
    if (previewWin === win) previewWin = null;
  });
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  void win.loadURL(url);
}

// ---- file-editor windows (.txt/.md "open with") ----------------------------

const OPENABLE_EXT = /\.(md|markdown|txt)$/i;

/** Pick real .md/.markdown/.txt paths out of a raw argv (drops flags/dirs).
 *  `cwd` anchors relative paths (a forwarded second-instance argv is relative
 *  to THAT instance's working directory, not ours). */
function fileArgsFrom(argv: string[], cwd?: string): string[] {
  return argv
    .filter((a) => !a.startsWith("-") && OPENABLE_EXT.test(a))
    .map((a) => resolve(cwd ?? process.cwd(), a))
    .filter((a) => existsSync(a));
}

/** Open now if the server is up, else queue for the end-of-startup drain. */
function queueOpenFile(p: string): void {
  const abs = resolve(p);
  if (serverPort) openFileWindow(abs);
  else pendingOpenFiles.push(abs);
}

function drainPendingFiles(): void {
  const files = pendingOpenFiles.splice(0);
  files.forEach(openFileWindow);
}

function setFileDirty(path: string, dirty: boolean): void {
  fileDirty.set(path, dirty);
  const win = fileWins.get(path);
  if (win && !win.isDestroyed() && process.platform === "darwin") win.setDocumentEdited(dirty);
}

/** Resolves when the renderer reports file:save-done, or after `ms`. */
function waitForSaveDone(win: BrowserWindow, ms: number): Promise<void> {
  return new Promise((done) => {
    const id = win.webContents.id;
    const t = setTimeout(() => {
      saveWaiters.delete(id);
      done();
    }, ms);
    saveWaiters.set(id, () => {
      clearTimeout(t);
      saveWaiters.delete(id);
      done();
    });
  });
}

/**
 * Open (or focus) the standalone file-editor window for a .txt/.md path. Loads
 * the shared WebUI at `…/#file?path=…` (see src/webui/fileviewer) — same origin
 * as the sidecar, so its 导入到 MetaHub button is a plain api.createDocument call.
 * One window per file; Cmd+S saves back to disk via the file: IPC below.
 */
function openFileWindow(absPath: string): void {
  if (!serverPort) {
    pendingOpenFiles.push(absPath);
    return;
  }
  allowedFilePaths.add(absPath);
  const existing = fileWins.get(absPath);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return;
  }
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 480,
    minHeight: 360,
    title: basename(absPath),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1a1c" : "#ffffff",
    show: false,
    // Same chrome policy as the main window: inset traffic lights on macOS
    // (the .fw-bar reserves space for them), native frame elsewhere.
    ...(isMac
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 17 } }
      : {}),
    webPreferences: {
      preload: appFile("dist", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  fileWins.set(absPath, win);
  fileDirty.set(absPath, false);
  if (isMac) win.setRepresentedFilename(absPath);
  routeExternalLinks(win);

  // Unsaved changes: intercept close with a native 保存/不保存/取消 sheet. "保存"
  // asks the renderer to write (file:request-save → file:save-done) and closes
  // once it reports back (3 s cap so a wedged renderer can't hold the window).
  win.on("close", (e) => {
    if (quitting || forceClosing.has(win) || !fileDirty.get(absPath)) return;
    e.preventDefault();
    void (async () => {
      const { response } = await dialog.showMessageBox(win, {
        type: "warning",
        buttons: ["保存", "不保存", "取消"],
        defaultId: 0,
        cancelId: 2,
        message: `是否保存对「${basename(absPath)}」的更改？`,
        detail: "不保存将丢弃自上次保存以来的更改。",
      });
      if (response === 2 || win.isDestroyed()) return;
      if (response === 0) {
        win.webContents.send("file:request-save");
        await waitForSaveDone(win, 3_000);
      }
      forceClosing.add(win);
      if (!win.isDestroyed()) win.close();
    })();
  });
  win.on("closed", () => {
    fileWins.delete(absPath);
    fileDirty.delete(absPath);
  });
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  const params = new URLSearchParams({ path: absPath });
  void win.loadURL(`http://127.0.0.1:${serverPort}/#file?${params.toString()}`);
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

// ---- mini windows (quick note / quick board) --------------------------------
// Two hide-don't-close companion windows with one shared lifecycle: pre-warmed
// hidden once the main window is up (first reveal = already painted, no white
// flash), summoned by a global shortcut or the tray, hidden on close, really
// destroyed only at quit. Per-window settings (shortcut / pin / bounds) live in
// their own userData JSON — machine-local state, never in the CRDT.

interface MiniWindowSettings {
  shortcut: string;
  alwaysOnTop: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}

interface MiniWindowSpec {
  title: string;
  /** Bare-hash entry in the shared webui bundle (see src/webui/app.tsx). */
  hash: string;
  /** IPC channel prefix ("qn" keeps its historical name for compat). */
  ipcPrefix: string;
  defaultShortcut: string;
  /** The note keeps quicknote-settings.json so existing installs migrate nothing. */
  settingsFile: string;
  defaultSize: { width: number; height: number };
  minSize: { width: number; height: number };
}

class MiniWindow {
  win: BrowserWindow | null = null;
  /** Currently registered global accelerator (null when registration failed). */
  shortcut: string | null = null;
  settings: MiniWindowSettings;
  private ready = false; // has this window painted at least once?
  private pendingShow = false; // reveal as soon as it paints

  constructor(readonly spec: MiniWindowSpec) {
    this.settings = { shortcut: spec.defaultShortcut, alwaysOnTop: false };
  }

  private settingsPath(): string {
    return join(app.getPath("userData"), this.spec.settingsFile);
  }

  loadSettings(): void {
    try {
      const raw = readFileSync(this.settingsPath(), "utf8");
      this.settings = { ...this.settings, ...(JSON.parse(raw) as MiniWindowSettings) };
    } catch {
      // first run / unreadable — keep defaults
    }
    if (!this.settings.shortcut) this.settings.shortcut = this.spec.defaultShortcut;
  }

  saveSettings(): void {
    try {
      writeFileSync(this.settingsPath(), JSON.stringify(this.settings, null, 2));
    } catch (err) {
      console.error(`[${this.spec.ipcPrefix}] failed to save settings:`, (err as Error).message);
    }
  }

  /** Default bottom-right placement on the primary display's work area. */
  private defaultBounds(): { x: number; y: number; width: number; height: number } {
    const { workArea } = screen.getPrimaryDisplay();
    const { width, height } = this.spec.defaultSize;
    const margin = 24;
    return {
      width,
      height,
      x: workArea.x + workArea.width - width - margin,
      y: workArea.y + workArea.height - height - margin,
    };
  }

  private create(): BrowserWindow {
    const isMac = process.platform === "darwin";
    const bounds = this.settings.bounds ?? this.defaultBounds();

    const win = new BrowserWindow({
      ...bounds,
      minWidth: this.spec.minSize.width,
      minHeight: this.spec.minSize.height,
      title: this.spec.title,
      show: false,
      resizable: true,
      alwaysOnTop: this.settings.alwaysOnTop,
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
      win.setAlwaysOnTop(this.settings.alwaysOnTop, "screen-saver");
      win.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    }

    routeExternalLinks(win);
    this.ready = false;
    void win.loadURL(`http://127.0.0.1:${serverPort}/${this.spec.hash}`);
    // Decouple create from show: ready-to-show only reveals the window if a show
    // was actually requested. This lets us pre-warm it hidden at startup (render
    // in the background) without it popping up — the first real open is instant.
    win.once("ready-to-show", () => {
      this.ready = true;
      if (this.pendingShow && !win.isDestroyed()) this.reveal(win);
    });

    const persistBounds = debounce(() => {
      if (!win.isDestroyed()) {
        this.settings.bounds = win.getBounds();
        this.saveSettings();
      }
    }, 400);
    win.on("resize", persistBounds);
    win.on("move", persistBounds);

    // Closing just hides — the window stays warm for an instant reopen. It is
    // really destroyed only when the whole app is quitting.
    win.on("close", (e) => {
      if (!quitting) {
        e.preventDefault();
        this.pendingShow = false;
        win.hide();
      }
    });
    win.on("closed", () => {
      if (this.win === win) {
        this.win = null;
        this.ready = false;
      }
    });

    return win;
  }

  private reveal(win: BrowserWindow): void {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  /** Create hidden and render in the background; cheap no-op if already warm. */
  prewarm(): void {
    if (!this.win || this.win.isDestroyed()) this.win = this.create();
  }

  show(): void {
    if (!this.win || this.win.isDestroyed()) this.win = this.create();
    this.pendingShow = true;
    // Pre-warmed at startup → already painted → reveal instantly. If the user is
    // fast enough to beat first paint, the ready-to-show handler reveals it then.
    if (this.ready) this.reveal(this.win);
  }

  toggle(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible() && this.win.isFocused()) {
      this.pendingShow = false;
      this.win.hide();
    } else {
      this.show();
    }
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  setAlwaysOnTop(on: boolean): boolean {
    this.settings.alwaysOnTop = on;
    if (this.win && !this.win.isDestroyed()) {
      // screen-saver level on macOS so the toggle keeps the window above
      // full-screened apps, matching the panel's cross-space behavior.
      this.win.setAlwaysOnTop(on, process.platform === "darwin" ? "screen-saver" : "normal");
    }
    this.saveSettings();
    return on;
  }

  /** Register `accel` for this window, replacing its previous registration.
   *  Refuses an accelerator the sibling window holds (same-app re-register
   *  would silently steal it). Returns success. */
  registerShortcut(accel: string): boolean {
    if (miniWindows.some((m) => m !== this && m.shortcut === accel)) return false;
    if (this.shortcut) {
      globalShortcut.unregister(this.shortcut);
      this.shortcut = null;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(accel, () => this.toggle());
    } catch {
      ok = false;
    }
    if (ok) this.shortcut = accel;
    return ok;
  }
}

const quickNote = new MiniWindow({
  title: "快速笔记",
  hash: "#quick",
  ipcPrefix: "qn",
  defaultShortcut: DEFAULT_NOTE_SHORTCUT,
  settingsFile: "quicknote-settings.json",
  defaultSize: { width: 420, height: 560 },
  minSize: { width: 280, height: 240 },
});

const quickBoard = new MiniWindow({
  title: "快速看板",
  hash: "#board",
  ipcPrefix: "qb",
  defaultShortcut: DEFAULT_BOARD_SHORTCUT,
  settingsFile: "quickboard-settings.json",
  defaultSize: { width: 720, height: 560 },
  minSize: { width: 400, height: 300 },
});

const miniWindows = [quickNote, quickBoard];

// ---- tray ------------------------------------------------------------------

function createTray(): void {
  const iconPath = appFile("assets", "trayTemplate.png");
  const image = nativeImage.createFromPath(iconPath);
  if (process.platform === "darwin") image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("Metahub");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "快速笔记", click: () => quickNote.show() },
      { label: "快速看板", click: () => quickBoard.show() },
      { type: "separator" },
      { label: "退出 Metahub", click: () => app.quit() },
    ]),
  );
  // Left-click toggles the note (context menu still available via right-click).
  tray.on("click", () => quickNote.toggle());
}

// ---- IPC (preload bridge) --------------------------------------------------

function registerIpc(): void {
  ipcMain.handle("app:get-version", () => app.getVersion());

  // Core sidecar update (desktop-only; the WebUI's "软件更新" settings section).
  // `installed` is the version staged on disk (version.json) — what the NEXT
  // launch will run; compared against the running core (/api/version) it tells
  // the UI whether an already-downloaded update is waiting for a restart.
  ipcMain.handle("core:installed-version", () => getInstalledCoreVersion());
  // `latest: null` means the GitHub lookup failed (offline/rate-limited) — the
  // WebUI renders that as 检查失败, never as 已是最新.
  ipcMain.handle("core:check", async () => {
    const release = await fetchLatestCoreRelease();
    return { latest: release ? tagToVersion(release.tag_name) : null };
  });
  // Reuses the startup auto-updater: fetch latest, compare vs staged, download +
  // verify + stage. Returns the staged version, or null if nothing newer.
  // Streams download progress to the invoking window (WebUI footer progress bar);
  // throttled to whole-percent changes (or ~100ms) so a ~64 MB download's thousands
  // of chunks don't flood IPC.
  ipcMain.handle("core:download", (e) => {
    let lastPct = -1;
    let lastAt = 0;
    return maybeUpdateCore((received, total) => {
      const now = Date.now();
      const pct = total > 0 ? Math.floor((received / total) * 100) : -1;
      if (pct === lastPct && now - lastAt < 100) return;
      lastPct = pct;
      lastAt = now;
      // Best-effort: the window may be gone before the ~64 MB stream finishes;
      // sending to a destroyed WebContents must not throw into the download.
      if (!e.sender.isDestroyed()) e.sender.send("core:download-progress", { received, total });
    });
  });
  ipcMain.handle("core:restart", () => {
    app.relaunch();
    app.quit();
  });

  // One identical IPC surface per mini window ("qn:*" / "qb:*").
  for (const m of miniWindows) {
    const p = m.spec.ipcPrefix;
    ipcMain.handle(`${p}:get-settings`, () => ({
      shortcut: m.settings.shortcut,
      alwaysOnTop: m.settings.alwaysOnTop,
    }));

    ipcMain.handle(`${p}:set-shortcut`, (_e, accel: string) => {
      const sibling = miniWindows.find((o) => o !== m && o.shortcut === accel);
      if (sibling) throw new Error(`快捷键「${accel}」已被「${sibling.spec.title}」占用`);
      const prev = m.shortcut;
      if (!m.registerShortcut(accel)) {
        if (prev) m.registerShortcut(prev); // restore the working binding
        throw new Error(`快捷键「${accel}」无法注册（可能被占用）`);
      }
      m.settings.shortcut = accel;
      m.saveSettings();
      return { shortcut: m.settings.shortcut, alwaysOnTop: m.settings.alwaysOnTop };
    });

    ipcMain.handle(`${p}:get-always-on-top`, () =>
      m.win && !m.win.isDestroyed() ? m.win.isAlwaysOnTop() : m.settings.alwaysOnTop,
    );

    ipcMain.handle(`${p}:set-always-on-top`, (_e, on: boolean) => m.setAlwaysOnTop(on));

    ipcMain.handle(`${p}:hide`, () => m.hide());
  }

  // Open the frameless image-preview window for a doc image (see openPreview).
  ipcMain.handle("preview:open", (_e, p: { src: string; name?: string; blockId: string }) => openPreview(p));

  // File-editor window bridge. Reads/writes are gated on allowedFilePaths —
  // only paths the main process itself opened (association/argv/open-file) —
  // so the renderer cannot roam the filesystem.
  const assertAllowed = (p: string): string => {
    const abs = resolve(p);
    if (!allowedFilePaths.has(abs)) throw new Error(`file not opened by Metahub: ${abs}`);
    return abs;
  };
  ipcMain.handle("file:read", (_e, p: string) => {
    const abs = assertAllowed(p);
    return { text: readFileSync(abs, "utf8"), name: basename(abs) };
  });
  ipcMain.handle("file:write", (_e, p: string, text: string) => {
    const abs = assertAllowed(p);
    writeFileSync(abs, text, "utf8");
    setFileDirty(abs, false);
  });
  ipcMain.handle("file:set-dirty", (_e, p: string, dirty: boolean) => {
    setFileDirty(assertAllowed(p), dirty);
  });
  ipcMain.handle("file:save-done", (e) => {
    saveWaiters.get(e.sender.id)?.();
  });
  // 导入到 MetaHub → raise the main window (the doc id travels renderer-to-
  // renderer over BroadcastChannel("mh-open-doc"); see file-editor.tsx).
  ipcMain.handle("file:focus-main", () => showMainWindow());

  // Open the Cloudflare OAuth consent page in the user's real browser (never an
  // in-app window). Restricted to the Cloudflare dash host so the renderer can't
  // drive the shell to arbitrary external URLs.
  ipcMain.handle("oauth:open-external", async (_e, url: string) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== "https:" || u.hostname !== "dash.cloudflare.com") return false;
    await shell.openExternal(u.toString());
    return true;
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
  if (legacyServiceWorkerCleanup.quarantined.length > 0) {
    void removeQuarantinedServiceWorkerStorage(legacyServiceWorkerCleanup.quarantined).then(
      (failures) => {
        if (failures.length > 0) {
          console.warn(
            "[desktop] could not remove detached Service Worker storage:",
            failures.join("; "),
          );
        }
      },
    );
  }
  // Windows/Linux: drop the default File/Edit/View… menu bar on every window.
  // macOS keeps its application menu (Cmd shortcuts live there).
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  for (const m of miniWindows) m.loadSettings();
  // Branded feedback up front, before any slow startup work begins.
  createSplash();
  try {
    serverPort = await startSidecar();
    await waitForHealth(serverPort);
    registerIpc();
    createWindow(serverPort);
    createTray();

    for (const m of miniWindows) {
      if (!m.registerShortcut(m.settings.shortcut) && m.settings.shortcut !== m.spec.defaultShortcut) {
        // Fall back to the default if a persisted custom shortcut is unavailable.
        m.registerShortcut(m.spec.defaultShortcut);
        m.settings.shortcut = m.spec.defaultShortcut;
        m.saveSettings();
      }
    }

    // macOS: re-open / focus the main window when the dock icon is clicked.
    app.on("activate", () => showMainWindow());

    // File-association opens: macOS Finder opens arrive via the early open-file
    // handler (queued above); Win/Linux — and a CLI launch on ANY platform,
    // e.g. `bun run dev file.md` (no Apple Event there) — pass the file in the
    // launch argv. Scan both; openFileWindow dedupes per path, so a path that
    // somehow arrives twice still gets one window. Server is healthy now — open.
    fileArgsFrom(process.argv).forEach(queueOpenFile);
    drainPendingFiles();
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
