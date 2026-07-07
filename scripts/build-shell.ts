// Build the static PWA shell for data-blind hosting (Cloudflare Pages / R2+CDN /
// COS static website / any static host). The shell carries no server and no
// hardcoded domain — it runs off its own self.location.origin, auto-detects
// no-origin mode (replica.ts detectOriginMode), and talks straight to the user's
// bucket. First install becomes "open a URL" instead of "reach my server".
//
// Reuses serveWebui() so there's a single source of truth for the HTML, manifest,
// service-worker version stamp, bundling, wasm, and icons: we just "request"
// each asset path and write the response to disk.
//
//   bun run scripts/build-shell.ts [--out dist/shell]

import { join, dirname } from "node:path";
import { serveWebui } from "../src/webui/server/assets.ts";
import { FMT_PROVIDERS } from "../src/webui/fmt/manifest.ts";

const outArg = process.argv.indexOf("--out");
const OUT = outArg >= 0 ? process.argv[outArg + 1]! : "dist/shell";

// Same asset surface the server serves at runtime. "/" → index.html; the rest
// keep their path as the filename. The 格式化 provider assets ride along so
// data-blind hosts have the files when a first format click fetches them.
const PATHS = [
  "/",
  "/webui.css",
  "/webui.js",
  "/sw.js",
  "/db-worker.js",
  "/mh-runtime.js",
  "/metahub-sdk.js",
  "/manifest.webmanifest",
  "/sqlite3.wasm",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-180.png",
  ...FMT_PROVIDERS.flatMap((p) => [p.js, ...(p.wasm ? [p.wasm.route] : [])]),
];

const fileFor = (p: string) => (p === "/" ? "index.html" : p.slice(1));

// Cloudflare Pages config: SPA fallback for client routes (real files take
// precedence, so /webui.js etc. still serve). /api/* and /sites/* are handled by
// the service worker once active. /health has no file → returns index.html under
// the SPA rule, but detectOriginMode checks the response *body* (not status), so
// the HTML still reads as "not a metahub server" → no-origin.
const REDIRECTS = `/*  /index.html  200\n`;
const HEADERS = `/sw.js\n  Service-Worker-Allowed: /\n/sqlite3.wasm\n  Content-Type: application/wasm\n` +
  FMT_PROVIDERS.filter((p) => p.wasm)
    .map((p) => `${p.wasm!.route}\n  Content-Type: application/wasm\n`)
    .join("");

async function main() {
  let bytesTotal = 0;
  for (const p of PATHS) {
    const res = await serveWebui(new Request(`http://shell${p}`));
    if (!res || !res.ok) throw new Error(`build-shell: serveWebui failed for ${p} (${res?.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The shell has no /api/version server; the settings footer shows the build
    // version stamped into webui.js instead. If the placeholder ever survives
    // (refactor broke the stamp), the footer would silently go blank — fail loud.
    if (p === "/webui.js" && new TextDecoder().decode(bytes).includes("__MH_WEBUI_VERSION__")) {
      throw new Error("build-shell: webui.js still has the unstamped __MH_WEBUI_VERSION__ placeholder");
    }
    const dest = join(OUT, fileFor(p));
    await Bun.write(dest, bytes);
    bytesTotal += bytes.byteLength;
    console.log(`  ${fileFor(p).padEnd(22)} ${(bytes.byteLength / 1024).toFixed(1)} KB`);
  }
  await Bun.write(join(OUT, "_redirects"), REDIRECTS);
  await Bun.write(join(OUT, "_headers"), HEADERS);
  console.log(`\nshell → ${OUT}  (${(bytesTotal / 1024 / 1024).toFixed(2)} MB across ${PATHS.length} files + _redirects/_headers)`);
}

void main();
