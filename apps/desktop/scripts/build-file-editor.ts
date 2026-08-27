/**
 * Build the disk-loaded file-editor shell (the .txt/.md "open with" window).
 *
 * Output: apps/desktop/dist/file-editor.{html,js,css}, loaded by main.ts via
 * win.loadFile — NOT served by the sidecar. That decouples opening an .md from
 * the whole server boot: the window appears with the file text already painted
 * (preload sync-read) while the sidecar starts in the background. The bundle
 * contains only the editor subtree (src/webui/fileviewer/standalone.tsx), a
 * bit over half the size of the full webui.js.
 *
 * `files: dist/**` in electron-builder.yml packs these into the asar; a build
 * without them simply falls back to the sidecar-served #file route (main.ts
 * fileEditorShellPath()).
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(desktopRoot, "..", "..");
const outdir = join(desktopRoot, "dist");

// Same theme FOUC guard idea as the sidecar HTML shell (assets.ts), except the
// stored choice can't be read here — file:// shares no localStorage with the
// sidecar origin — so main.ts passes ?theme= (the OS/nativeTheme resolution)
// and the OS preference is the fallback.
const HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Metahub</title>
<script>try{var q=new URLSearchParams(location.search).get('theme'),d=q?q==='dark':matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.dataset.resolved=d?'dark':'light'}catch(e){}</script>
<link rel="stylesheet" href="./file-editor.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="./file-editor.js"></script>
</body>
</html>`;

const result = await Bun.build({
  entrypoints: [join(repoRoot, "src", "webui", "fileviewer", "standalone.tsx")],
  target: "browser",
  format: "esm",
  minify: true,
  naming: "file-editor.js",
});
if (!result.success) {
  console.error(result.logs);
  throw new Error("file-editor build failed");
}
const js = await result.outputs[0]!.text();

// Browser-safety guard (mirrors scripts/build.ts assertBrowserSafe): a Bun-only
// module leaking into this bundle would explode at some user's first click.
if (/\bBun\.[A-Za-z]/.test(js)) {
  throw new Error("file-editor.js references the Bun global — a server-only module leaked in");
}
if (/from\s*["'](node|bun):/.test(js) || /require\(["'](node|bun):/.test(js)) {
  throw new Error("file-editor.js leaked a node:/bun: import — it cannot run in a browser");
}
// The fmt providers must stay lazy routes here too (same invariant as webui.js).
if (js.includes("mh-fmt-")) {
  throw new Error("a fmt provider bundle got inlined into file-editor.js — the lazy import regressed");
}

await Bun.write(join(outdir, "file-editor.js"), js);
await Bun.write(join(outdir, "file-editor.css"), Bun.file(join(repoRoot, "src", "webui", "styles.css")));
await Bun.write(join(outdir, "file-editor.html"), HTML);
console.log(`file-editor shell → ${outdir} (${(js.length / 1024).toFixed(0)} KB js)`);
