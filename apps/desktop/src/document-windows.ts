import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tm } from "./i18n";
import { validDocumentId, visibleDocumentBounds, type WindowBounds } from "./document-window-policy";

type SaveResult = { ok: boolean; error?: string };

export function installDocumentWindows(options: {
  origin: () => Promise<string>;
  preload: () => string;
  openMain: (id: string) => void;
  routeLinks: (win: BrowserWindow) => void;
  quitting: () => boolean;
}) {
  const windows = new Map<string, BrowserWindow>();
  const dirty = new Set<number>();
  const registered = new Set<number>();
  const approved = new WeakSet<BrowserWindow>();
  const closing = new Map<BrowserWindow, Promise<boolean>>();
  const waiters = new Map<number, { requestId: number; done: (result: SaveResult) => void }>();
  let requestSeq = 0;
  let origin = "";
  const boundsFile = () => join(app.getPath("userData"), "document-windows.json");
  const readBounds = (): Record<string, WindowBounds> => {
    try { const data = JSON.parse(readFileSync(boundsFile(), "utf8")); return data && typeof data === "object" && !Array.isArray(data) ? data : {}; }
    catch { return {}; }
  };
  const resume = (win: BrowserWindow) => { if (!win.isDestroyed()) win.webContents.send("documents:resume"); };
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    if (!origin || event.senderFrame !== event.sender.mainFrame) return false;
    try { const url = new URL(event.senderFrame.url); return url.origin === origin && url.pathname === "/"; }
    catch { return false; }
  };

  function requestSave(win: BrowserWindow): Promise<SaveResult> {
    const requestId = ++requestSeq;
    const id = win.webContents.id;
    return new Promise((resolve) => {
      const timer = setTimeout(() => done({ ok: false, error: tm("保存未完成，请重试。") }), 10_000);
      const done = (result: SaveResult) => {
        clearTimeout(timer);
        waiters.delete(id);
        resolve(result);
      };
      waiters.set(id, { requestId, done });
      win.webContents.send("documents:save", requestId);
    });
  }

  function prepareClose(win: BrowserWindow, freeze = false): Promise<boolean> {
    const pending = closing.get(win);
    if (pending) return pending;
    const task = (async () => {
      if (win.isDestroyed() || (!freeze && !dirty.has(win.webContents.id)) || !registered.has(win.webContents.id)) return true;
      for (;;) {
        const result = await requestSave(win);
        if (win.isDestroyed()) return true;
        if (result.ok && !dirty.has(win.webContents.id)) return true;
        win.show();
        win.focus();
        const { response } = await dialog.showMessageBox(win, {
          type: "warning", message: tm("文档尚未保存"),
          detail: result.error || tm("请先处理未保存的修改。"),
          buttons: [tm("重试"), tm("取消"), tm("放弃未保存修改")], defaultId: 0, cancelId: 1,
        });
        if (response === 2) return true;
        if (response === 1) { resume(win); return false; }
      }
    })();
    closing.set(win, task);
    void task.finally(() => closing.delete(win));
    return task;
  }

  // This also protects documents hosted by the main window and record drawers.
  app.on("browser-window-created", (_event, win) => {
    win.on("close", (event) => {
      if (/#(quick|board)$/.test(win.webContents.getURL()) && !options.quitting()) return;
      if (options.quitting() || approved.has(win) || !dirty.has(win.webContents.id)) return;
      event.preventDefault();
      void prepareClose(win).then((ok) => {
        if (ok && !win.isDestroyed()) { approved.add(win); win.close(); }
      });
    });
    win.webContents.on("will-prevent-unload", (event) => {
      if (approved.has(win) || options.quitting()) event.preventDefault();
    });
    const id = win.webContents.id;
    win.on("closed", () => {
      dirty.delete(id);
      registered.delete(id);
      waiters.get(id)?.done({ ok: false, error: tm("窗口已关闭") });
    });
  });

  async function open(id: unknown) {
    if (!validDocumentId(id)) throw new Error("Invalid document ID");
    origin = await options.origin();
    const existing = windows.get(id);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show(); existing.focus(); return;
    }
    const bounds = visibleDocumentBounds(readBounds()[id], screen.getAllDisplays().map((display) => display.workArea));
    const win = new BrowserWindow({
      ...bounds, minWidth: 520, minHeight: 400, show: false, title: "Metahub",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1a1c" : "#ffffff",
      ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 17 } } : {}),
      webPreferences: { preload: options.preload(), contextIsolation: true, nodeIntegration: false, additionalArguments: [`--mh-document=${id}`] },
    });
    windows.set(id, win);
    options.routeLinks(win);
    win.once("ready-to-show", () => { win.show(); win.focus(); });
    win.on("close", () => {
      try {
        const saved = readBounds();
        delete saved[id];
        const next = Object.fromEntries([...Object.entries(saved).slice(-79), [id, win.getNormalBounds()]]);
        writeFileSync(boundsFile(), JSON.stringify(next));
      } catch { /* Position persistence must never block closing. */ }
    });
    win.on("closed", () => { if (windows.get(id) === win) windows.delete(id); });
    try { await win.loadURL(`${origin}/#/doc/${id}`); }
    catch (error) { if (!win.isDestroyed()) win.destroy(); throw error; }
  }

  return {
    open,
    async ready() { origin = await options.origin(); },
    registerIpc() {
      ipcMain.handle("documents:open", async (event, id: unknown) => {
        if (!trusted(event)) throw new Error("Untrusted document window");
        await open(id);
      });
      ipcMain.handle("documents:open-main", (event, id: unknown) => {
        if (!trusted(event) || !validDocumentId(id)) throw new Error("Invalid document request");
        options.openMain(id);
      });
      ipcMain.on("documents:dirty", (event, value: unknown) => {
        if (!trusted(event) || typeof value !== "boolean") return;
        registered.add(event.sender.id);
        if (value) dirty.add(event.sender.id); else dirty.delete(event.sender.id);
        BrowserWindow.fromWebContents(event.sender)?.setDocumentEdited(value);
      });
      ipcMain.on("documents:saved", (event, requestId: unknown, result: SaveResult) => {
        if (!trusted(event) || typeof result?.ok !== "boolean") return;
        const waiter = waiters.get(event.sender.id);
        if (waiter && waiter.requestId === requestId) waiter.done({ ok: result.ok, error: typeof result.error === "string" ? result.error : undefined });
      });
    },
    async prepareQuit() {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!await prepareClose(win, true)) { this.resumeAll(); return false; }
      }
      return true;
    },
    resumeAll() { for (const win of BrowserWindow.getAllWindows()) resume(win); },
  };
}
