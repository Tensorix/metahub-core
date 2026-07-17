// Resolves the edge worker script text `mh edge deploy` uploads, following the
// WebUI asset three-way pattern (webui/server/assets.ts):
//   1. injected — `bun build --compile` binaries embed dist/edge-worker.js via
//      compiled-entry.ts and hand it in through setEdgeWorkerScript();
//   2. source tree — dev runs bundle src/workers/edge-worker.ts on demand;
//   3. sibling dist — packaged cli.js sits next to dist/edge-worker.js.

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { MhError } from "../core/errors.ts";

const RUNNING_FROM_SOURCE = import.meta.url.includes("/src/cli/");

let injected: string | null = null;

/** Called by compiled-entry.ts before the CLI runs. */
export function setEdgeWorkerScript(script: string): void {
  injected = script;
}

export async function getEdgeWorkerScript(): Promise<string> {
  if (injected) return injected;
  const here = dirname(fileURLToPath(import.meta.url));
  if (RUNNING_FROM_SOURCE) {
    const r = await Bun.build({
      entrypoints: [join(here, "../workers/edge-worker.ts")],
      target: "browser",
      format: "esm",
      external: ["cloudflare:workers"],
    });
    if (!r.success) throw new Error(`edge-worker bundling failed: ${r.logs.map(String).join("\n")}`);
    return r.outputs[0]!.text();
  }
  const sibling = Bun.file(join(here, "edge-worker.js")); // dist/cli.js ↔ dist/edge-worker.js
  if (await sibling.exists()) return sibling.text();
  throw new MhError(
    "not_found",
    "edge-worker bundle missing — this build lacks dist/edge-worker.js (run: bun run build)",
  );
}
