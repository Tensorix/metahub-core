// Build the static object-storage share viewer for data-blind hosting
// (Cloudflare Pages / any static host). It carries no server and no bucket
// credentials: it reads the presigned manifest URL + per-share key from the URL
// fragment, fetches the ciphertext straight from the bucket, decrypts it in the
// browser, and renders. This is the host for `mh share create --transport s3`
// links; point `cfg_share_viewer_url` (or `mh share create --viewer`) at it.
//
//   bun run scripts/build-share-viewer.ts [--out dist/share-viewer]

import { join } from "node:path";
import { shellHtml } from "../src/webui/share/share-shell.ts";

const outArg = process.argv.indexOf("--out");
const OUT = outArg >= 0 ? process.argv[outArg + 1]! : "dist/share-viewer";

const REDIRECTS = `/*  /index.html  200\n`;
const HEADERS = `/share-viewer.js\n  Content-Type: text/javascript\n`;

async function main() {
  const result = await Bun.build({
    entrypoints: ["src/webui/share/share-viewer.ts"],
    target: "browser",
    minify: true,
    naming: "share-viewer.js",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("build-share-viewer: bundling failed");
  }
  const js = await result.outputs[0]!.text();
  await Bun.write(join(OUT, "share-viewer.js"), js);
  await Bun.write(join(OUT, "index.html"), shellHtml());
  await Bun.write(join(OUT, "_redirects"), REDIRECTS);
  await Bun.write(join(OUT, "_headers"), HEADERS);
  console.log(`share-viewer → ${OUT}  (${(js.length / 1024).toFixed(1)} KB js + index.html + _redirects/_headers)`);
}

void main();
