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
import { desktopHost } from "./loopback";
import { z } from "zod";
import "../../../src/core/sync/storage-s3-bun.ts";
import { rebuildDesktopReplica } from "../../../src/core/sync/recovery-desktop.ts";
import { recoveryItems, resolveRecoveryItem } from "../../../src/core/sync/recovery-v2.ts";
import type { Route } from "../../../src/core/sync/routes.ts";
import { startServer } from "../../../src/core/sync/server.ts";
import { serveWebui, warmWebui } from "../../../src/webui/server/assets.ts";
import { webuiRoutes, webuiOnStart } from "../../../src/webui/server/routes.ts";

import { inspectWorkspaceVersion, upgradeBuckets, inspectConnectedWorkspaceAccess } from "../../../src/core/sync/recovery-local.ts";

const recoveryRoutes: Route[] = [
  { method: "GET", path: "/api/local-recovery/upgrade", summary: "Available workspace upgrades", response: z.array(z.string()),
    handler: (_, { db }) => Response.json(upgradeBuckets(db)) },
  { method: "GET", path: "/api/local-recovery/compatibility", summary: "Workspace compatibility and recovery targets",
    response: z.object({ urls: z.array(z.string()), dataVersion: z.number(), workspaceAccess: z.array(z.any()) }),
    handler: async (_, { db }) => {
      const dataVersion = await inspectWorkspaceVersion(db);
      const workspaceAccess = await inspectConnectedWorkspaceAccess(db);
      return Response.json({ urls: upgradeBuckets(db), dataVersion, workspaceAccess });
    } },
  { method: "GET", path: "/api/local-recovery/items", summary: "Pending desktop recovery items", response: z.any(),
    handler: (_, { db }) => Response.json(recoveryItems(db)) },
  { method: "POST", path: "/api/local-recovery/items", summary: "Resolve a desktop recovery item", response: z.any(),
    async handler(request,{ db }) {
      const { id, action } = z.object({ id: z.string(), action: z.enum(["copy","discard"]) }).parse(await request.json());
      return Response.json({ documentId: resolveRecoveryItem(db,id,action) });
    } },
];

export function runSidecar(): void {
  if (process.argv.includes("--rebuild-replica")) {
    const url = process.env.METAHUB_REBUILD_PEER;
    if (!url) throw new Error("A connected bucket is required");
    void rebuildDesktopReplica(url, undefined, process.env.METAHUB_REBUILD_AUTOMATIC === "1").then(
      result => console.log("METAHUB_REBUILT="+JSON.stringify(result)),
      error => { console.error(error instanceof Error ? error.message : "Local recovery failed"); process.exitCode = 1; },
    );
    return;
  }
  const t0 = Date.now();
  const s = startServer({
    debug: true, // no token auth: the window is the only client, bound to loopback
    host: desktopHost, // never exposed off the machine
    port: Number(process.env.METAHUB_RESTART_PORT || 0), // let the OS pick a free port, so we never clash with `mh --server`
    allowRemoteSiteHosting: false,
    loopbackUiOnly: true,
    // Core ships no UI — the sidecar injects the WebUI it exists to serve.
    ui: { serveAssets: serveWebui, routes: [...webuiRoutes, ...recoveryRoutes], onStart: webuiOnStart },
  });

  // Contract with main.ts: this exact prefix is matched to extract the port.
  console.log(`METAHUB_PORT=${s.port}`);
  console.log(`[perf] startServer total ${Date.now() - t0}ms`);

  // Pre-build the WebUI bundle in the background so the window's first
  // `/webui.js` request doesn't pay for a cold `Bun.build` (dev only; the
  // packaged bundle is embedded). Fire-and-forget — must not delay the port
  // line above.
  void warmWebui();

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
