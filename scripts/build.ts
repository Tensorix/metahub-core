import { rm, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
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

// Service worker (PWA offline shell). Separate classic-script bundle: it must
// not share module scope with the app, and the server stamps a version hash
// into it at serve time (see src/webui/server/assets.ts getSw()).
const swResult = await Bun.build({
  entrypoints: ["src/webui/sw.ts"],
  outdir,
  target: "browser",
  format: "esm",
  minify: true,
  naming: "sw.js",
});

if (!swResult.success) {
  console.error(swResult.logs);
  throw new Error("Service worker build failed");
}

// Browser-replica DB worker (sqlite-wasm host) + the wasm binary it loads,
// the injected page runtime, and the sites data SDK.
const browserBundles: [entry: string, name: string][] = [
  ["src/webui/data/db-worker.ts", "db-worker.js"],
  ["src/webui/runtime.ts", "mh-runtime.js"],
  ["src/sdk/client.ts", "metahub-sdk.js"],
];
for (const [entry, name] of browserBundles) {
  const r = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "browser",
    format: "esm",
    minify: true,
    naming: name,
  });
  if (!r.success) {
    console.error(r.logs);
    throw new Error(`${name} build failed`);
  }
}

const wasmSrc = join(
  dirname(Bun.resolveSync("@sqlite.org/sqlite-wasm", import.meta.dir)),
  "sqlite3.wasm",
);
await Bun.write(`${outdir}/sqlite3.wasm`, Bun.file(wasmSrc));

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

// `mh init --claude` / `mh init --codex` ship the repo-root SKILL.md embedded as
// a text import (src/cli/agent-skill.ts). If the bundler ever stops inlining it,
// the installers would silently write an empty skill — so fail the build loudly.
if (!cliContent.includes("durable, syncable working memory")) {
  throw new Error("cli.js is missing the embedded SKILL.md body (mh init agent skills)");
}

await Bun.write(cliPath, `#!/usr/bin/env bun\n${cliContent}`);
await chmod(cliPath, 0o755);

await $`tsc -p tsconfig.build.json`;

console.log("✅ Build complete");
