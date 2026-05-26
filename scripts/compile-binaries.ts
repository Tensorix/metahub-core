import { mkdir } from "node:fs/promises";
import { $ } from "bun";

const targets = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-windows-x64",
] as const;

const outdir = "binaries";
await mkdir(outdir, { recursive: true });

for (const target of targets) {
  const platform = target.replace(/^bun-/, "");
  const ext = platform.startsWith("windows") ? ".exe" : "";
  const outfile = `${outdir}/metahub-${platform}${ext}`;
  console.log(`▶ Building ${outfile}`);
  await $`bun build --compile --target=${target} src/cli/index.ts --outfile ${outfile}`;
}

console.log("✅ All binaries built");
