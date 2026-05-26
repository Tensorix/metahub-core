import { rm, chmod } from "node:fs/promises";
import { $ } from "bun";

const outdir = "dist";

await rm(outdir, { recursive: true, force: true });

const libResult = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir,
  target: "node",
  format: "esm",
  sourcemap: "external",
});

if (!libResult.success) {
  console.error(libResult.logs);
  throw new Error("Library build failed");
}

const cliResult = await Bun.build({
  entrypoints: ["src/cli/index.ts"],
  outdir,
  target: "node",
  format: "esm",
  sourcemap: "external",
  naming: "cli.js",
});

if (!cliResult.success) {
  console.error(cliResult.logs);
  throw new Error("CLI build failed");
}

const cliPath = `${outdir}/cli.js`;
const cliContent = await Bun.file(cliPath).text();
await Bun.write(cliPath, `#!/usr/bin/env node\n${cliContent}`);
await chmod(cliPath, 0o755);

await $`tsc -p tsconfig.build.json`;

console.log("✅ Build complete");
