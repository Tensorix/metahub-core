// Build the static object-storage share viewer for data-blind hosting
// (Cloudflare Pages / any static host). It carries no server and no bucket
// credentials: it reads the presigned manifest URL + per-share key from the URL
// fragment, fetches the ciphertext straight from the bucket, decrypts it in the
// browser, and renders. This is the host for `mh share create --transport s3`
// links; point `cfg_share_viewer_url` (or `mh share create --viewer`) at it.
//
//   bun run scripts/build-share-viewer.ts [--out dist/share-viewer]

import { join } from "node:path";

const outArg = process.argv.indexOf("--out");
const OUT = outArg >= 0 ? process.argv[outArg + 1]! : "dist/share-viewer";

const CSS = `:root{--bg:#fff;--fg:#1f2328;--muted:#6e7781;--line:#d0d7de;--accent:#0969da;--card:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--accent:#4493f8;--card:#161b22}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif}
#app{max-width:820px;margin:0 auto;padding:32px 20px 80px}
header.mh{margin-bottom:18px;border-bottom:1px solid var(--line);padding-bottom:12px}header.mh h1{font-size:22px;margin:0}
article.doc h1,article.doc h2,article.doc h3{line-height:1.3;margin:1.4em 0 .5em}article.doc h1{font-size:1.7em}article.doc h2{font-size:1.4em}
article.doc img{max-width:100%;border-radius:8px}article.doc pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px;overflow:auto}
article.doc code{background:var(--card);padding:.15em .35em;border-radius:4px;font-size:.9em}article.doc pre code{background:none;padding:0}
article.doc blockquote{margin:.8em 0;padding:.2em 1em;border-left:3px solid var(--line);color:var(--muted)}
table.db,article.doc table{border-collapse:collapse;width:100%;font-size:14px}table.db td,table.db th,article.doc td,article.doc th{border:1px solid var(--line);padding:7px 10px;text-align:left}
table.db th{background:var(--card)}.table-wrap{overflow:auto}.tag{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:999px;padding:1px 9px;font-size:12px}
.muted{color:var(--muted)}.err{color:#cf222e}footer.mh{margin-top:48px;border-top:1px solid var(--line);padding-top:14px;color:var(--muted);font-size:12px;text-align:center}`;

const HTML = `<!doctype html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>分享</title>
<style>${CSS}</style></head><body>
<div id="app"><p class="muted">正在加载…</p></div>
<script type="module" src="./share-viewer.js"></script>
</body></html>`;

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
  await Bun.write(join(OUT, "index.html"), HTML);
  await Bun.write(join(OUT, "_redirects"), REDIRECTS);
  await Bun.write(join(OUT, "_headers"), HEADERS);
  console.log(`share-viewer → ${OUT}  (${(js.length / 1024).toFixed(1)} KB js + index.html + _redirects/_headers)`);
}

void main();
