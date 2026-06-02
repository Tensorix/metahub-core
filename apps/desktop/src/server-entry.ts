/**
 * Bun sidecar entry for the Metahub desktop app.
 *
 * Electron's main process runs on Node and cannot use Bun-only APIs
 * (bun:sqlite, Bun.serve, ...), so the core sync server runs here, in a Bun
 * child process. We reuse `startServer()` verbatim — no core changes — and
 * print the OS-assigned port on a parseable line so the Electron main process
 * can discover it and point a BrowserWindow at the embedded WebUI.
 */
import { startServer } from "../../../src/core/sync/server.ts";

const s = startServer({
  debug: true, // no token auth: the window is the only client, bound to loopback
  host: "127.0.0.1", // never exposed off the machine
  port: 0, // let the OS pick a free port, so we never clash with `mh --server`
});

// Contract with main.ts: this exact prefix is matched to extract the port.
console.log(`METAHUB_PORT=${s.port}`);

function shutdown(): void {
  try {
    s.stop();
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
