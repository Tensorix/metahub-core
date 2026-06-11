/**
 * Compile-only entry for the CLI binary.
 *
 * `bun build --compile` (see scripts/compile-binaries.ts) produces a standalone
 * binary with no source tree and no sibling dist/webui.js, so getJs()'s two
 * fallbacks both fail and `/webui.js` 500s. We embed the prebuilt WebUI bundle
 * as text and hand it to the core via setWebuiBundle() before the CLI runs.
 *
 * Kept separate from src/cli/index.ts so the dev / npm entrypoint never hard-
 * imports dist/webui.js (which doesn't exist on a fresh checkout). index.ts runs
 * runMain on import, so we dynamic-import it *after* setWebuiBundle() to
 * guarantee the bundle is registered before the server can serve a request.
 *
 * Requires a full dist/ (root `bun run build`) at compile time: webui.js,
 * sw.js, db-worker.js, sqlite3.wasm.
 */
import webuiBundle from "../../dist/webui.js" with { type: "text" };
import swBundle from "../../dist/sw.js" with { type: "text" };
import dbWorkerBundle from "../../dist/db-worker.js" with { type: "text" };
import runtimeBundle from "../../dist/mh-runtime.js" with { type: "text" };
import sdkBundle from "../../dist/metahub-sdk.js" with { type: "text" };
// `file` loader: the wasm is embedded in the compiled binary and the import
// resolves to a readable virtual path at runtime.
import wasmPath from "../../dist/sqlite3.wasm" with { type: "file" };
import { setWebuiBundle } from "../webui/server/assets.ts";

setWebuiBundle({
  js: webuiBundle,
  sw: swBundle,
  dbWorker: dbWorkerBundle,
  runtime: runtimeBundle,
  sdk: sdkBundle,
  wasm: new Uint8Array(await Bun.file(wasmPath).arrayBuffer()),
});
await import("./index.ts");
