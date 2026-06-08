import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";
import pkg from "../package.json" with { type: "json" };
import { hostBunTarget, verifyBinaryVersion } from "./verify-binary-version.ts";

const targets = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-windows-x64",
] as const;

const outdir = "binaries";
await mkdir(outdir, { recursive: true });

const host = hostBunTarget();
for (const target of targets) {
  const platform = target.replace(/^bun-/, "");
  const ext = platform.startsWith("windows") ? ".exe" : "";
  const outfile = `${outdir}/metahub-${platform}${ext}`;
  console.log(`▶ Building ${outfile}`);
  await $`bun build --compile --target=${target} src/cli/index.ts --outfile ${outfile}`;
  // Only the host-native target can run here; it proves the whole set's version.
  if (target === host) await verifyBinaryVersion(resolve(outfile), { expected: pkg.version, kind: "cli" });
}

console.log("✅ All binaries built");
