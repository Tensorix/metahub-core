/**
 * Shared Bun sidecar startup for the Metahub desktop app.
 *
 * Electron's main process runs on Node and cannot use Bun-only APIs
 * (bun:sqlite, Bun.serve, ...), so the core sync server runs here, in a Bun
 * process. We reuse `startServer()` verbatim — no core changes — and print the
 * OS-assigned port on a parseable line so the Electron main process can
 * discover it and point a BrowserWindow at the embedded WebUI.
 *
 * Two entrypoints call this:
 *  - server-entry.ts  — dev: run from source via `bun run` (WebUI builds lazily)
 *  - server-bundle.ts — prod: compiled to a standalone binary (WebUI embedded)
 */
import { startServer } from "../../../src/core/sync/server.ts";

export function runSidecar(): void {
  const s = startServer({
    debug: true, // no token auth: the window is the only client, bound to loopback
    host: "127.0.0.1", // never exposed off the machine
    port: 0, // let the OS pick a free port, so we never clash with `mh --server`
  });

  // Contract with main.ts: this exact prefix is matched to extract the port.
  console.log(`METAHUB_PORT=${s.port}`);

  // Pre-build the WebUI bundle in the background so the window's first
  // `/webui.js` request doesn't pay for a cold `Bun.build` (dev only; the
  // packaged bundle is embedded). Fire-and-forget — must not delay the port
  // line above, and webui.ts stays out of the CLI's startup import graph since
  // only this sidecar entry pulls it in.
  void import("../../../src/core/sync/webui.ts").then((m) => m.warmWebui()).catch(() => {});

  const shutdown = (): void => {
    try {
      s.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
