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
 * Requires dist/webui.js (root `bun run build`) at compile time.
 */
import webuiBundle from "../../dist/webui.js" with { type: "text" };
import { setWebuiBundle } from "../core/sync/webui.ts";

setWebuiBundle(webuiBundle);
await import("./index.ts");
