/**
 * Electron main process for the Metahub desktop app.
 *
 * Runs on Electron's bundled Node runtime. It spawns the Bun sidecar
 * (server-entry.ts) which starts the real metahub server, discovers the
 * sidecar's port from stdout, waits for /health, then loads the embedded
 * WebUI in a BrowserWindow. No core logic lives here — this is just a shell.
 */
import { app, BrowserWindow, dialog } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const HEALTH_PATH = "/health"; // mirrors src/core/sync/protocol.ts
const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_INTERVAL_MS = 150;

let sidecar: ChildProcess | null = null;

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
  const entry = join(__dirname, "..", "src", "server-entry.ts");
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

function createWindow(port: number): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 720,
    minHeight: 480,
    title: "Metahub",
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void win.loadURL(`http://127.0.0.1:${port}/`);
}

function killSidecar(): void {
  if (sidecar && !sidecar.killed) sidecar.kill();
  sidecar = null;
}

app.whenReady().then(async () => {
  try {
    const port = await startSidecar();
    await waitForHealth(port);
    createWindow(port);

    // macOS: re-open a window when the dock icon is clicked.
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
    });
  } catch (err) {
    killSidecar();
    dialog.showErrorBox("Metahub failed to start", (err as Error).message);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Ensure the sidecar never outlives the app.
app.on("before-quit", killSidecar);
app.on("will-quit", killSidecar);
process.on("exit", killSidecar);
