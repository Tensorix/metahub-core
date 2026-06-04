/**
 * Dev sidecar entry for the Metahub desktop app.
 *
 * Used in development only: the Electron main process spawns this via
 * `bun run src/server-entry.ts`, running from source. The WebUI bundle is built
 * lazily on first request (see src/core/sync/webui.ts getJs()), so this entry
 * does NOT embed it. The production path uses server-bundle.ts instead.
 */
import { runSidecar } from "./sidecar.ts";

runSidecar();
