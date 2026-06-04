/**
 * Production sidecar entry for the Metahub desktop app.
 *
 * Compiled to a standalone Bun binary via `bun build --compile` (see
 * scripts/build-sidecars.ts), which embeds the Bun runtime, bun:sqlite, the
 * core sync server, and — crucially — the prebuilt WebUI bundle below. A
 * compiled binary has no source tree and no sibling dist/webui.js, so we import
 * the bundle as embedded text and hand it to the core via setWebuiBundle()
 * before starting. Requires `dist/webui.js` (root `bun run build`) at compile time.
 */
import webuiBundle from "../../../dist/webui.js" with { type: "text" };
import { setWebuiBundle } from "../../../src/core/sync/webui.ts";
import { runSidecar } from "./sidecar.ts";

setWebuiBundle(webuiBundle);
runSidecar();
