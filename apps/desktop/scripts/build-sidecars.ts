/**
 * Compile the desktop sidecar (server-bundle.ts) into self-contained Bun
 * binaries. Each embeds the Bun runtime, bun:sqlite, the core sync server, and
 * the prebuilt WebUI bundle, so the packaged app needs neither Bun on PATH nor
 * any source tree at runtime.
 *
 * Output names match electron-builder's ${arch} macro (see electron-builder.yml):
 * the mac/win/linux extraResources pick the matching file per build.
 *
 * By DEFAULT this builds only the HOST platform's sidecar(s) — that's all the
 * electron-builder packaging on this OS needs, and it avoids fragile/wasteful
 * cross-compilation (notably, cross-compiling the darwin targets on a Windows
 * runner fails to extract the bun executable). Set `SIDECAR_ALL=1` to build
 * every target from one host — that's what the core release workflow does to
 * publish all sidecars as the desktop auto-update source.
 *
 * Run from anywhere; it cwds to the repo root so relative imports resolve.
 */
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";
import pkg from "../../../package.json" with { type: "json" };
import { hostBunTarget, verifyBinaryVersion } from "../../../scripts/verify-binary-version.ts";

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

const allTargets = [
  { bun: "bun-darwin-arm64", out: "metahub-sidecar-mac-arm64", os: "darwin" },
  { bun: "bun-darwin-x64", out: "metahub-sidecar-mac-x64", os: "darwin" },
  { bun: "bun-windows-x64", out: "metahub-sidecar-win-x64.exe", os: "win32" },
  { bun: "bun-linux-x64", out: "metahub-sidecar-linux-x64", os: "linux" },
] as const;

const buildAll = process.env.SIDECAR_ALL === "1";
const targets = buildAll ? allTargets : allTargets.filter((t) => t.os === process.platform);
if (targets.length === 0) {
  throw new Error(`no sidecar target for host platform ${process.platform}`);
}
console.log(buildAll ? "▶ building ALL sidecar targets" : `▶ building host (${process.platform}) sidecars`);

const host = hostBunTarget();
for (const t of targets) {
  const outfile = `${outdir}/${t.out}`;
  console.log(`▶ Building ${outfile}`);
  await $`bun build --compile --target=${t.bun} ${entry} --outfile ${outfile}`;
  // Only the host-native target can run here; it proves the whole set's version.
  if (t.bun === host) await verifyBinaryVersion(join(repoRoot, outfile), { expected: pkg.version, kind: "sidecar" });
}

console.log("✅ Sidecar binaries built");
