// Electron main-process test harness. Drive real renderer buttons without opening a remote debugger.
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const { writeFileSync, unlinkSync } = require("node:fs");
const desktop = process.env.MH_ACCEPTANCE_DESKTOP;
const profile = process.env.MH_TEST_USER_DATA;
if (!desktop || !profile || !process.env.METAHUB_HOME)
  throw new Error("Isolated acceptance environment required");
app.setAppPath(desktop);
require(join(desktop, "dist/main.js"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) {
  console.log("[acceptance] " + label);
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  const win = BrowserWindow.getAllWindows().find((w) =>
    w.webContents.getURL().startsWith("http"),
  );
  const state =
    win &&
    (await win.webContents.executeJavaScript(
      "document.body.innerText.slice(-1300)",
    ));
  throw new Error("Timed out: " + label + " " + state);
}
async function run() {
  await app.whenReady();
  const win = await until(
    () =>
      BrowserWindow.getAllWindows().find((w) =>
        /^http:\/\/\[::1\]:\d+\/$/.test(w.webContents.getURL()) && !w.webContents.isLoadingMainFrame()
      ),
    "sidecar window",
  );
  const origin = new URL(win.webContents.getURL()).origin;
  await win.loadURL(origin + "/?lang=zh-CN#/settings?sec=backup");
  const js = (code) => win.webContents.executeJavaScript(code);
  const click = (label) =>
    until(
      () =>
        js(
          "(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===" +
            JSON.stringify(label) +
            "&&!b.disabled);if(b){b.click();return true}})()",
        ),
      label,
    );
  const status = (message) =>
    until(
      () =>
        js(
          "document.body.textContent.includes(" +
            JSON.stringify(message) +
            ")",
        ),
      message,
    );
  if (process.env.MH_ACCEPTANCE_RESTART) {
    await until(
      () =>
        js(
          "Array.from(document.querySelectorAll('details')).some(d=>d.textContent.includes('desktop offline text'))",
        ),
      "recovery after restart",
    );
  } else {
    // A second renderer refuses its save request. The same IPC handshake is
    // used by real document editors, and recovery must leave the sidecar live.
    const editor = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(desktop, "dist/preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await editor.loadURL(origin + "/#/settings?sec=backup");
    await editor.webContents.executeJavaScript(`
      window.metahubDesktop.documents.onRequestSave(id =>
        window.metahubDesktop.documents.saveDone(id,{ok:false,error:"secondary editor has pending input"}));
      window.metahubDesktop.documents.setDirty(true);
    `);
    await click("立即升级");
    await status("secondary editor has pending input");
    if (!(await js("fetch('/health').then(r=>r.ok)")))
      throw new Error("original sidecar unavailable after editor refusal");
    editor.destroy();
    await click("立即升级");
    await status("Attachment protection");
    unlinkSync(join(process.env.METAHUB_HOME, "cache", "0".repeat(32)));
    await click("立即升级");
    await until(() => js("fetch('/api/local-recovery/items').then(r=>r.json()).then(items=>items.some(i=>i.local.includes('unpublished desktop draft'))).catch(()=>false)"), "installed recovery items");
    const path =
      "/api/document/at?" +
      new URLSearchParams({
        id: process.env.MH_ACCEPTANCE_CLOUD_ID,
        version: process.env.MH_ACCEPTANCE_VERSION,
      });
    const revision = await js(
      "fetch(" + JSON.stringify(path) + ").then(r=>r.json())",
    );
    if (revision.body !== "cloud history")
      throw new Error(
        "Desktop archive read failed: " + JSON.stringify(revision),
      );
    await until(
      () =>
        js(
          "(()=>{const d=[...document.querySelectorAll('details')].find(d=>d.textContent.includes('unpublished desktop draft'));if(!d)return false;d.open=true;d.querySelector('button').click();return true})()",
        ),
      "resolve draft",
    );
    await until(
      () =>
        js(
          "![...document.querySelectorAll('details')].some(d=>d.textContent.includes('unpublished desktop draft'))",
        ),
      "durable resolution",
    );
  }
  writeFileSync(
    join(profile, "acceptance-result.json"),
    JSON.stringify({ ok: true }),
  );
}
run()
  .catch((error) =>
    writeFileSync(
      join(profile, "acceptance-result.json"),
      JSON.stringify({ ok: false, error: String(error.stack) }),
    ),
  )
  .finally(() => {
    app.quit();
    setTimeout(() => app.exit(0), 4000).unref();
  });
