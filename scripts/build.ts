import { rm, chmod } from "node:fs/promises";
import { $ } from "bun";

const outdir = "dist";

await rm(outdir, { recursive: true, force: true });

const libResult = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir,
  target: "bun",
  format: "esm",
  sourcemap: "external",
});

if (!libResult.success) {
  console.error(libResult.logs);
  throw new Error("Library build failed");
}

// Browser WebUI bundle (Preact). Self-hosted so the UI works offline, and kept
// as its own entrypoint so it never enters the CLI's startup import graph.
const webuiResult = await Bun.build({
  entrypoints: ["src/webui/app.tsx"],
  outdir,
  target: "browser",
  format: "esm",
  minify: true,
  naming: "webui.js",
});

if (!webuiResult.success) {
  console.error(webuiResult.logs);
  throw new Error("WebUI build failed");
}

const cliResult = await Bun.build({
  entrypoints: ["src/cli/index.ts"],
  outdir,
  target: "bun",
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
await Bun.write(cliPath, `#!/usr/bin/env bun\n${cliContent}`);
await chmod(cliPath, 0o755);

await $`tsc -p tsconfig.build.json`;

console.log("✅ Build complete");
