// Isolated acceptance harness around the real desktop main/preload/renderer.
const { app, BrowserWindow, ipcMain } = require("electron");
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");
const profile = process.env.MH_TEST_USER_DATA;
const desktop = process.env.MH_ACCEPTANCE_DESKTOP;
if (!profile || !desktop || !process.env.METAHUB_HOME) throw new Error("isolated profile required");
app.setAppPath(desktop);
let rebuilds = 0, upgradeDialogs = 0;
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => register(channel, channel === "replica:rebuild" ? async (...args) => {
  rebuilds++;
  if (args[1] !== process.env.MH_ACCEPTANCE_PEER || args[2] !== true) throw new Error("unexpected manual rebuild");
  return listener(...args);
} : listener);
app.on("web-contents-created", (_, contents) => {
  contents.on("did-finish-load", () => {
    if (!contents.getURL().startsWith("http")) return;
    void contents.executeJavaScript(`
      window.__bootstrapDialogs = 0;
      const inspect = () => { if ([...document.querySelectorAll('dialog')].some(d => /升级工作区同步|更新本地副本/.test(d.textContent))) window.__bootstrapDialogs++; };
      new MutationObserver(inspect).observe(document.body, {childList:true,subtree:true}); inspect();
    `).catch(() => {});
  });
});
require(join(desktop, "dist/main.js"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) { const value = await fn().catch(() => false); if (value) return value; await delay(100); }
  throw new Error("Timed out: " + label);
}
async function run() {
  await app.whenReady();
  const win = await until(async () => BrowserWindow.getAllWindows().find(w => /^http:\/\//.test(w.webContents.getURL()) && !w.webContents.isLoadingMainFrame()), "renderer");
  await until(async () => {
    const info = await win.webContents.executeJavaScript("fetch('/api/local-recovery/compatibility',{cache:'no-store'}).then(r=>r.json())");
    return info.workspaceAccess.some(s => s.url === process.env.MH_ACCEPTANCE_PEER && s.kind === "ready");
  }, "automatic initialization");
  upgradeDialogs += await win.webContents.executeJavaScript("window.__bootstrapDialogs || 0");
  if (upgradeDialogs || rebuilds !== (process.env.MH_ACCEPTANCE_RESTART ? 0 : 1)) throw new Error(`unexpected confirmation or duplicate switch: dialogs=${upgradeDialogs} rebuilds=${rebuilds}`);
  const origin = new URL(win.webContents.getURL()).origin;
  await win.loadURL(origin + "/?lang=zh-CN#/doc/" + process.env.MH_ACCEPTANCE_DOCUMENT);
  await until(async () => win.webContents.executeJavaScript("document.body.textContent.includes('baseline text')"), "installed document in renderer");
  if (!(await win.webContents.executeJavaScript("fetch('/health').then(r=>r.ok)"))) throw new Error("restarted sidecar unavailable");
  const image = await win.webContents.capturePage();
  writeFileSync(join(profile, process.env.MH_ACCEPTANCE_RESTART ? "restart.png" : "first-join.png"), image.toPNG());
  writeFileSync(join(profile, "result.json"), JSON.stringify({ ok: true, rebuilds, upgradeDialogs, electron: process.versions.electron }));
}
run().catch(error => writeFileSync(join(profile, "result.json"), JSON.stringify({ ok: false, error: String(error.stack) }))).finally(() => { app.quit(); setTimeout(() => app.exit(0), 4000).unref(); });
