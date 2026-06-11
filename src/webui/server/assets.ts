import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
// Inlined as a string at build time (Bun text loader), so packaged builds and
// compiled binaries carry the stylesheet with no extra asset file. In dev the
// file is re-read from disk per request instead — see getCss().
import APP_CSS from "../styles.css" with { type: "text" };
import { ICON_192, ICON_512, ICON_180 } from "./icons.ts";

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
<!-- FOUC guard: resolve the stored choice (system → OS preference) to an
     explicit data-resolved before first paint. CSS keys off data-resolved
     alone, so the dark palette exists exactly once — see styles.css. Dark also
     pre-tints the status bar (hex mirrors --bg) so the first frame isn't white. -->
<script>try{var t=localStorage.getItem('mh-theme'),d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.resolved=d?'dark':'light';if(d)document.getElementById('theme-color-meta').content='#1a1a1c'}catch(e){}</script>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icons/icon-180.png">
<link rel="stylesheet" href="/webui.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="/webui.js"></script>
</body>
</html>`;

/** Bundles injected by `bun build --compile` binaries (e.g. the desktop
 *  sidecar), where neither a sibling dist/ nor the source tree exists at
 *  runtime — embedded at build time and handed in here. */
let injectedJs: string | null = null;
let injectedSw: string | null = null;
let injectedDbWorker: string | null = null;
let injectedWasm: Uint8Array | null = null;

export function setWebuiBundle(bundle: {
  js: string;
  sw: string;
  dbWorker: string;
  wasm: Uint8Array;
}): void {
  injectedJs = bundle.js;
  injectedSw = bundle.sw;
  injectedDbWorker = bundle.dbWorker;
  injectedWasm = bundle.wasm;
}

let cachedJs: string | null = null;
/** Dev only: newest src/webui mtime baked into cachedJs (cache key). */
let cachedJsMtime = 0;
let cachedSw: string | null = null;
let cachedSwMtime = 0;
let cachedDbWorker: string | null = null;
let cachedDbWorkerMtime = 0;

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

/** The service worker source, resolved like getJs(): embedded > dev rebuild >
 *  prebuilt dist/sw.js. Version interpolation happens in getSw() below. */
async function getSwRaw(): Promise<string> {
  if (injectedSw != null) return injectedSw;

  if (RUNNING_FROM_SOURCE) {
    const srcDir = fileURLToPath(new URL("..", import.meta.url));
    const newest = newestSourceMtime(srcDir);
    if (cachedSw == null || newest > cachedSwMtime) {
      const entry = fileURLToPath(new URL("../sw.ts", import.meta.url));
      const res = await Bun.build({ entrypoints: [entry], target: "browser" });
      if (!res.success) throw new AggregateError(res.logs, "sw build failed");
      cachedSw = await res.outputs[0]!.text();
      cachedSwMtime = newest;
    }
    return cachedSw;
  }

  if (cachedSw == null) {
    const prebuilt = Bun.file(fileURLToPath(new URL("./sw.js", import.meta.url)));
    if (!(await prebuilt.exists())) {
      throw new Error("sw bundle missing: dist/sw.js was not built — run `bun run build`");
    }
    cachedSw = await prebuilt.text();
  }
  return cachedSw;
}

/** /sw.js with its cache version stamped in: a hash of the current js+css, so
 *  any bundle change byte-diffs the worker (the browser's update trigger) and
 *  stale shell caches are dropped on activation. */
async function getSw(): Promise<string> {
  const [raw, js, css] = await Promise.all([getSwRaw(), getJs(), getCss()]);
  const version = new Bun.CryptoHasher("sha256").update(js).update(css).digest("hex").slice(0, 16);
  return raw.replaceAll("__MH_SW_VERSION__", version);
}

/** The DB worker (browser replica host), resolved like getJs(). */
async function getDbWorker(): Promise<string> {
  if (injectedDbWorker != null) return injectedDbWorker;

  if (RUNNING_FROM_SOURCE) {
    const srcDir = fileURLToPath(new URL("..", import.meta.url));
    const newest = newestSourceMtime(srcDir);
    if (cachedDbWorker == null || newest > cachedDbWorkerMtime) {
      const entry = fileURLToPath(new URL("../data/db-worker.ts", import.meta.url));
      const res = await Bun.build({ entrypoints: [entry], target: "browser" });
      if (!res.success) throw new AggregateError(res.logs, "db-worker build failed");
      cachedDbWorker = await res.outputs[0]!.text();
      cachedDbWorkerMtime = newest;
    }
    return cachedDbWorker;
  }

  if (cachedDbWorker == null) {
    const prebuilt = Bun.file(fileURLToPath(new URL("./db-worker.js", import.meta.url)));
    if (!(await prebuilt.exists())) {
      throw new Error("db-worker bundle missing: dist/db-worker.js was not built — run `bun run build`");
    }
    cachedDbWorker = await prebuilt.text();
  }
  return cachedDbWorker;
}

/** sqlite3.wasm bytes: embedded (compiled binary) > node_modules (dev) >
 *  sibling dist copy (packaged; build.ts copies it next to the bundles). */
async function getWasm(): Promise<Uint8Array> {
  if (injectedWasm != null) return injectedWasm;
  const path = RUNNING_FROM_SOURCE
    ? join(
        dirname(Bun.resolveSync("@sqlite.org/sqlite-wasm", fileURLToPath(new URL(".", import.meta.url)))),
        "sqlite3.wasm",
      )
    : fileURLToPath(new URL("./sqlite3.wasm", import.meta.url));
  const f = Bun.file(path);
  if (!(await f.exists())) {
    throw new Error(`sqlite3.wasm missing at ${path} — run \`bun install\` / \`bun run build\``);
  }
  return new Uint8Array(await f.arrayBuffer());
}

/** Web app manifest: installability metadata for add-to-home-screen/PWA. */
const MANIFEST = JSON.stringify({
  name: "Metahub",
  short_name: "Metahub",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#ffffff",
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
});

const ICONS: Record<string, string> = {
  "/icons/icon-192.png": ICON_192,
  "/icons/icon-512.png": ICON_512,
  "/icons/icon-180.png": ICON_180,
};

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
  if (pathname === "/manifest.webmanifest") return asset(MANIFEST, "application/manifest+json");
  const icon = ICONS[pathname];
  if (icon) {
    return new Response(Buffer.from(icon, "base64"), {
      // Icons never change within a deploy; let the browser keep them a day.
      headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
    });
  }
  if (pathname === "/sqlite3.wasm") {
    try {
      // Cast: the ESNext lib types Uint8Array<ArrayBufferLike>, which current
      // lib.dom's BodyInit doesn't admit; at runtime Response accepts it fine.
      return new Response((await getWasm()) as unknown as BodyInit, {
        // ~1MB and changes only on dependency upgrades; the service worker
        // additionally keeps it cache-first for offline starts.
        headers: { "content-type": "application/wasm", "cache-control": "public, max-age=86400" },
      });
    } catch (e) {
      console.error("[webui] failed to serve /sqlite3.wasm —", e);
      return new Response(`sqlite3.wasm unavailable: ${e}`, { status: 500 });
    }
  }
  if (pathname === "/webui.js" || pathname === "/sw.js" || pathname === "/db-worker.js") {
    try {
      const body =
        pathname === "/sw.js"
          ? await getSw()
          : pathname === "/db-worker.js"
            ? await getDbWorker()
            : await getJs();
      return asset(body, "text/javascript; charset=utf-8");
    } catch (e) {
      // This catch is the only thing between the error and oblivion: Bun only
      // auto-logs *uncaught* handler errors, and we catch this one. Log the full
      // error object (not `${e}`) so getJs's AggregateError sub-logs surface —
      // otherwise the 500 lives solely in the response body, never the logs.
      console.error(`[webui] failed to serve ${pathname} —`, e);
      return new Response(`webui build failed: ${e}`, { status: 500 });
    }
  }
  return null;
}
