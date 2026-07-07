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
// Lazy 格式化 provider assets (routes in src/webui/fmt/manifest.ts). Import
// attributes must be literals, so these are enumerated by hand — adding a
// provider means adding its line(s) here.
import fmtCore from "../../dist/webui-fmt.js" with { type: "text" };
import fmtRuff from "../../dist/webui-fmt-ruff.js" with { type: "text" };
import fmtGofmt from "../../dist/webui-fmt-gofmt.js" with { type: "text" };
import fmtClang from "../../dist/webui-fmt-clang.js" with { type: "text" };
import fmtLua from "../../dist/webui-fmt-lua.js" with { type: "text" };
import fmtTaplo from "../../dist/webui-fmt-taplo.js" with { type: "text" };
import fmtSh from "../../dist/webui-fmt-sh.js" with { type: "text" };
import fmtRuffWasm from "../../dist/webui-fmt-ruff.wasm" with { type: "file" };
import fmtGofmtWasm from "../../dist/webui-fmt-gofmt.wasm" with { type: "file" };
import fmtClangWasm from "../../dist/webui-fmt-clang.wasm" with { type: "file" };
import fmtLuaWasm from "../../dist/webui-fmt-lua.wasm" with { type: "file" };
import fmtTaploWasm from "../../dist/webui-fmt-taplo.wasm" with { type: "file" };
import { setWebuiBundle } from "../webui/server/assets.ts";

const bytes = async (p: string) => new Uint8Array(await Bun.file(p).arrayBuffer());

setWebuiBundle({
  js: webuiBundle,
  sw: swBundle,
  dbWorker: dbWorkerBundle,
  runtime: runtimeBundle,
  sdk: sdkBundle,
  wasm: await bytes(wasmPath),
  fmt: {
    "/webui-fmt.js": fmtCore,
    "/webui-fmt-ruff.js": fmtRuff,
    "/webui-fmt-gofmt.js": fmtGofmt,
    "/webui-fmt-clang.js": fmtClang,
    "/webui-fmt-lua.js": fmtLua,
    "/webui-fmt-taplo.js": fmtTaplo,
    "/webui-fmt-sh.js": fmtSh,
  },
  fmtWasm: {
    "/webui-fmt-ruff.wasm": await bytes(fmtRuffWasm),
    "/webui-fmt-gofmt.wasm": await bytes(fmtGofmtWasm),
    "/webui-fmt-clang.wasm": await bytes(fmtClangWasm),
    "/webui-fmt-lua.wasm": await bytes(fmtLuaWasm),
    "/webui-fmt-taplo.wasm": await bytes(fmtTaploWasm),
  },
});
await import("./index.ts");
