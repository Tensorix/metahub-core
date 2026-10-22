// Build the object-storage share viewer and optional Pages/D1 short-link API.
// The browser alone receives the content key in the fragment. The API stores
// only presigned URLs and management capability hashes. Static hosts can omit
// _worker.js and continue serving legacy links.
// The viewer fetches ciphertext directly from the user's bucket and decrypts
// in the browser. Point cfg_share_viewer_url (or --viewer) at this deployment.
//
//   bun run scripts/build-share-viewer.ts [--out dist/share-viewer]

import { join } from "node:path";
import { shellHtml } from "../src/webui/share/share-shell.ts";
import { BRAND_IMAGES } from "../src/webui/brand-images.ts";

const outArg = process.argv.indexOf("--out");
const OUT = outArg >= 0 ? process.argv[outArg + 1]! : "dist/share-viewer";

// Pages supplies the index.html SPA fallback itself; an explicit /* rewrite
// loops with Pages' .html normalization in current Wrangler.
// The extensionless target also avoids a 308 that would discard the share ID.
const REDIRECTS = `/s/* /short 200\n`;
const HEADERS = `/*\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n/share-viewer.js\n  Content-Type: text/javascript\n`;

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
  // Absolute assets on deep links, relative assets for existing subpath hosts.
  await Bun.write(join(OUT, "short.html"), shellHtml("/share-viewer.js").replace('href="./favicon.png"', 'href="/favicon.png"'));
  const worker = await Bun.build({ entrypoints: ["src/workers/share-viewer.ts"], target: "browser", format: "esm", minify: true });
  if (!worker.success) throw new Error(`share-viewer worker build failed: ${worker.logs.join("\n")}`);
  await Bun.write(join(OUT, "_worker.js"), worker.outputs[0]!);
  // Only API calls invoke the Worker: all viewer assets stay on free static CDN.
  await Bun.write(join(OUT, "_routes.json"), JSON.stringify({ version: 1, include: ["/api/*"], exclude: [] }));
  for (const tone of ["light", "dark"] as const) {
    await Bun.write(join(OUT, `brand-${tone}.png`), Buffer.from(BRAND_IMAGES.color[tone][192], "base64"));
  }
  await Bun.write(join(OUT, "favicon.png"), Buffer.from(BRAND_IMAGES.color.light[32], "base64"));
  await Bun.write(join(OUT, "_redirects"), REDIRECTS);
  await Bun.write(join(OUT, "_headers"), HEADERS);
  console.log(`share-viewer → ${OUT}  (${(js.length / 1024).toFixed(1)} KB js + index.html + _redirects/_headers)`);
}

void main();
