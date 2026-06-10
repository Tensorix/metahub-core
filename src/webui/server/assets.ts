import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
// Inlined as a string at build time (Bun text loader), so packaged builds and
// compiled binaries carry the stylesheet with no extra asset file. In dev the
// file is re-read from disk per request instead — see getCss().
import APP_CSS from "../styles.css" with { type: "text" };

// Serves the browser WebUI at `/`. Core never imports this module: it is wired
// into the server through startServer's `ui` option (see core/sync/server.ts),
// keeping presentation code out of the core layer and off the CLI startup path.
// The Preact bundle itself is built or loaded lazily on the first request.

/** True when running from the source tree (bun dev / bun test) rather than a
 *  packaged dist build or a compiled binary. Switches asset serving to
 *  rebuild-on-change so a browser refresh is enough to see edits. */
const RUNNING_FROM_SOURCE = import.meta.url.includes("/src/webui/");

/** The HTML shell. The Preact app and stylesheet are delivered separately as
 *  /webui.js and /webui.css (both served below, never cached). */
const HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<!-- Mobile browser chrome (status/address bar) tints to theme-color; app.tsx
     keeps #theme-color-meta in sync with the active theme + visible surface. -->
<meta name="theme-color" id="theme-color-meta" content="#ffffff" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<title>Metahub</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<!-- Load web fonts without blocking first paint: media="print" keeps the
     stylesheet non-render-blocking, then onload flips it to "all". The page
     paints instantly with the system-font fallbacks baked into --ui/--mono and
     swaps to the web fonts when they arrive (or stays on system fonts offline).
     This is what kept the desktop cold-start white for seconds on slow networks. -->
<link rel="stylesheet" media="print" onload="this.media='all'" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"></noscript>
<script>try{document.documentElement.dataset.theme=localStorage.getItem('mh-theme')||'system'}catch(e){}</script>
<link rel="stylesheet" href="/webui.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="/webui.js"></script>
</body>
</html>`;

/** Bundle injected by `bun build --compile` binaries (e.g. the desktop
 *  sidecar), where neither a sibling dist/webui.js nor the source tree exists
 *  at runtime — the bundle is embedded at build time and handed in here. */
let injectedJs: string | null = null;

export function setWebuiBundle(js: string): void {
  injectedJs = js;
}

let cachedJs: string | null = null;
/** Dev only: newest src/webui mtime baked into cachedJs (cache key). */
let cachedJsMtime = 0;

/** Newest mtime across the browser-bundle sources (src/webui/**.ts[x]).
 *  ./server is skipped — server-side code never enters the browser bundle. */
function newestSourceMtime(dir: string): number {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "server" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestSourceMtime(p));
    else if (/\.tsx?$/.test(e.name)) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

/** Resolve the app bundle: embedded (compiled binary) > rebuild-on-change from
 *  source (dev) > prebuilt sibling dist/webui.js (packaged), process-cached. */
async function getJs(): Promise<string> {
  if (injectedJs != null) return injectedJs;

  if (RUNNING_FROM_SOURCE) {
    // Dev: rebuild whenever any source file is newer than the cached bundle,
    // so a plain browser refresh picks up edits — no rebuild step, no restart.
    const srcDir = fileURLToPath(new URL("..", import.meta.url));
    const newest = newestSourceMtime(srcDir);
    if (cachedJs == null || newest > cachedJsMtime) {
      const entry = fileURLToPath(new URL("../app.tsx", import.meta.url));
      const res = await Bun.build({ entrypoints: [entry], target: "browser" });
      if (!res.success) throw new AggregateError(res.logs, "webui build failed");
      cachedJs = await res.outputs[0]!.text();
      cachedJsMtime = newest;
    }
    return cachedJs;
  }

  if (cachedJs == null) {
    const prebuilt = Bun.file(fileURLToPath(new URL("./webui.js", import.meta.url)));
    if (!(await prebuilt.exists())) {
      throw new Error(
        "webui bundle missing: dist/webui.js was not built — run `bun run build`",
      );
    }
    cachedJs = await prebuilt.text();
  }
  return cachedJs;
}

/** The stylesheet: read from disk per request in dev (so CSS edits land on the
 *  next refresh), the build-time inlined copy otherwise. */
async function getCss(): Promise<string> {
  if (RUNNING_FROM_SOURCE) {
    return Bun.file(fileURLToPath(new URL("../styles.css", import.meta.url))).text();
  }
  return APP_CSS;
}

/** Pre-build & cache the JS bundle ahead of the first request. In dev the first
 *  `/webui.js` hit otherwise pays for a `Bun.build` (1–3s) that blocks the
 *  WebUI's first paint; warming it right after the server starts listening
 *  moves that cost off the cold-start critical path. In packaged builds the
 *  bundle is already embedded via setWebuiBundle(), so this is a no-op. */
export async function warmWebui(): Promise<void> {
  try {
    await getJs();
  } catch {
    // best-effort: a failed warm just falls back to building on first request
  }
}

// Served by a local server to (mostly) one machine: `no-store` everywhere
// trades a few KB per load for never needing a hard refresh after an update.
function asset(body: string, contentType: string): Response {
  return new Response(body, {
    headers: { "content-type": contentType, "cache-control": "no-store" },
  });
}

/** Handle WebUI asset requests. Returns null for anything else so the caller
 *  can fall through to the API routes. */
export async function serveWebui(req: Request): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const { pathname } = new URL(req.url);

  if (pathname === "/") return asset(HTML, "text/html; charset=utf-8");
  if (pathname === "/webui.css") return asset(await getCss(), "text/css; charset=utf-8");
  if (pathname === "/webui.js") {
    try {
      return asset(await getJs(), "text/javascript; charset=utf-8");
    } catch (e) {
      // This catch is the only thing between the error and oblivion: Bun only
      // auto-logs *uncaught* handler errors, and we catch this one. Log the full
      // error object (not `${e}`) so getJs's AggregateError sub-logs surface —
      // otherwise the 500 lives solely in the response body, never the logs.
      console.error("[webui] failed to serve /webui.js —", e);
      return new Response(`webui build failed: ${e}`, { status: 500 });
    }
  }
  return null;
}
