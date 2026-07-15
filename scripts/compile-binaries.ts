import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";
import pkg from "../package.json" with { type: "json" };
import { hostBunTarget, verifyBinaryVersion } from "./verify-binary-version.ts";
import { smokeWebui } from "./smoke-webui.ts";
import { smokeSkill } from "./smoke-skill.ts";

const allTargets = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-windows-x64",
  // needs Bun >= 1.3.10 (first release to ship windows-aarch64)
  "bun-windows-arm64",
] as const;

const outdir = "binaries";
await mkdir(outdir, { recursive: true });

// compiled-entry.ts embeds dist/webui.js as text so the binary can serve the
// WebUI (no source tree / sibling dist/webui.js exists at runtime) — ensure it's built.
if (!existsSync("dist/webui.js")) {
  console.log("▶ dist/webui.js missing — running root build first");
  await $`bun run build`;
}

const host = hostBunTarget();
// HOST_ONLY=1 → compile just the runner's native target. Same compile + smoke
// (version / WebUI serve / skill embed) as the full set, minus the cross-compiled
// artifacts — the fast per-push CI gate (see .github/workflows/ci.yml).
const targets = process.env.HOST_ONLY === "1" ? ([host] as const) : allTargets;
for (const target of targets) {
  const platform = target.replace(/^bun-/, "");
  const ext = platform.startsWith("windows") ? ".exe" : "";
  const outfile = `${outdir}/metahub-${platform}${ext}`;
  console.log(`▶ Building ${outfile}`);
  await $`bun build --compile --target=${target} src/cli/compiled-entry.ts --outfile ${outfile}`;
  // Only the host-native target can run here; it proves the whole set's version
  // and that the embedded WebUI bundle is actually served (guards the 500 regression).
  if (target === host) {
    await verifyBinaryVersion(resolve(outfile), { expected: pkg.version, kind: "cli" });
    await smokeWebui(resolve(outfile));
    // Proves the embedded `/mh` skill (SKILL.md text import) rode into the binary.
    await smokeSkill(resolve(outfile));
  }
}

console.log("✅ All binaries built");
