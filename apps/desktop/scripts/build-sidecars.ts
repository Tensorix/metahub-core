/**
 * Compile the desktop sidecar (server-bundle.ts) into self-contained Bun
 * binaries for every shipped platform. Each binary embeds the Bun runtime,
 * bun:sqlite, the core sync server, and the prebuilt WebUI bundle, so the
 * packaged app needs neither Bun on PATH nor any source tree at runtime.
 *
 * Output names match electron-builder's ${arch} macro (see electron-builder.yml):
 * the mac/win/linux extraResources pick the matching file per build.
 *
 * Run from anywhere; it cwds to the repo root so relative imports resolve.
 * `bun build --compile` cross-compiles all targets from a single host.
 */
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

// apps/desktop/scripts → repo root
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
$.cwd(repoRoot);

// server-bundle.ts imports dist/webui.js as embedded text — ensure it exists.
if (!existsSync(join(repoRoot, "dist", "webui.js"))) {
  console.log("▶ dist/webui.js missing — running root build first");
  await $`bun run build`;
}

const entry = "apps/desktop/src/server-bundle.ts";
const outdir = "apps/desktop/resources";
await mkdir(join(repoRoot, outdir), { recursive: true });

const targets = [
  { bun: "bun-darwin-arm64", out: "metahub-sidecar-mac-arm64" },
  { bun: "bun-darwin-x64", out: "metahub-sidecar-mac-x64" },
  { bun: "bun-windows-x64", out: "metahub-sidecar-win-x64.exe" },
  { bun: "bun-linux-x64", out: "metahub-sidecar-linux-x64" },
] as const;

for (const t of targets) {
  const outfile = `${outdir}/${t.out}`;
  console.log(`▶ Building ${outfile}`);
  await $`bun build --compile --target=${t.bun} ${entry} --outfile ${outfile}`;
}

console.log("✅ Sidecar binaries built");
