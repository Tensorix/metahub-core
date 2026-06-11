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
const injected: Record<string, string | null> = {
  js: null,
  sw: null,
  dbWorker: null,
  runtime: null,
  sdk: null,
};
let injectedWasm: ArrayBuffer | null = null;

export function setWebuiBundle(bundle: {
  js: string;
  sw: string;
  dbWorker: string;
  runtime: string;
  sdk: string;
  wasm: Uint8Array;
}): void {
  injected.js = bundle.js;
  injected.sw = bundle.sw;
  injected.dbWorker = bundle.dbWorker;
  injected.runtime = bundle.runtime;
  injected.sdk = bundle.sdk;
  // Normalize to a whole ArrayBuffer (what Response accepts under every lib).
  const w = bundle.wasm;
  injectedWasm =
    w.byteOffset === 0 && w.byteLength === w.buffer.byteLength
      ? (w.buffer as ArrayBuffer)
      : (w.slice().buffer as ArrayBuffer);
}

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

/**
 * One resolver per browser bundle, all with the same three-way strategy:
 * embedded (compiled binary) > rebuild-on-change from source (dev: any newer
 * source file triggers a rebuild, so a refresh is enough) > prebuilt dist
 * sibling (packaged builds), process-cached.
 */
function bundleGetter(opts: {
  key: keyof typeof injected;
  /** Dev entrypoint, relative to this file. */
  entry: string;
  /** Prebuilt artifact name in dist/ (sibling of the compiled assets.js). */
  dist: string;
  /** Extra source dirs (relative to repo src/) the dev mtime scan must cover. */
  extraDirs?: string[];
}): () => Promise<string> {
  let cached: string | null = null;
  let cachedMtime = 0;
  return async () => {
    const fromBinary = injected[opts.key];
    if (fromBinary != null) return fromBinary;

    if (RUNNING_FROM_SOURCE) {
      const srcDir = fileURLToPath(new URL("..", import.meta.url));
      let newest = newestSourceMtime(srcDir);
      for (const extra of opts.extraDirs ?? []) {
        newest = Math.max(newest, newestSourceMtime(fileURLToPath(new URL(extra, import.meta.url))));
      }
      if (cached == null || newest > cachedMtime) {
        const entry = fileURLToPath(new URL(opts.entry, import.meta.url));
        const res = await Bun.build({ entrypoints: [entry], target: "browser" });
        if (!res.success) throw new AggregateError(res.logs, `${opts.dist} build failed`);
        cached = await res.outputs[0]!.text();
        cachedMtime = newest;
      }
      return cached;
    }

    if (cached == null) {
      const prebuilt = Bun.file(fileURLToPath(new URL(`./${opts.dist}`, import.meta.url)));
      if (!(await prebuilt.exists())) {
        throw new Error(`${opts.dist} missing: run \`bun run build\``);
      }
      cached = await prebuilt.text();
    }
    return cached;
  };
}

const getJs = bundleGetter({ key: "js", entry: "../app.tsx", dist: "webui.js" });
const getSwRaw = bundleGetter({ key: "sw", entry: "../sw.ts", dist: "sw.js" });
const getDbWorker = bundleGetter({ key: "dbWorker", entry: "../data/db-worker.ts", dist: "db-worker.js" });
const getRuntime = bundleGetter({ key: "runtime", entry: "../runtime.ts", dist: "mh-runtime.js" });
const getSdk = bundleGetter({ key: "sdk", entry: "../../sdk/client.ts", dist: "metahub-sdk.js", extraDirs: ["../../sdk"] });

/** The stylesheet: read from disk per request in dev (so CSS edits land on the
 *  next refresh), the build-time inlined copy otherwise. */
async function getCss(): Promise<string> {
  if (RUNNING_FROM_SOURCE) {
    return Bun.file(fileURLToPath(new URL("../styles.css", import.meta.url))).text();
  }
  return APP_CSS;
}

/** /sw.js with its cache version stamped in: a hash of the current js+css, so
 *  any bundle change byte-diffs the worker (the browser's update trigger) and
 *  stale shell caches are dropped on activation. */
async function getSw(): Promise<string> {
  const [raw, js, css] = await Promise.all([getSwRaw(), getJs(), getCss()]);
  const version = new Bun.CryptoHasher("sha256").update(js).update(css).digest("hex").slice(0, 16);
  return raw.replaceAll("__MH_SW_VERSION__", version);
}

/** sqlite3.wasm bytes: embedded (compiled binary) > node_modules (dev) >
 *  sibling dist copy (packaged; build.ts copies it next to the bundles). */
async function getWasm(): Promise<ArrayBuffer> {
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
  return f.arrayBuffer();
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
      return new Response(await getWasm(), {
        // ~1MB and changes only on dependency upgrades; the service worker
        // additionally keeps it cache-first for offline starts.
        headers: { "content-type": "application/wasm", "cache-control": "public, max-age=86400" },
      });
    } catch (e) {
      console.error("[webui] failed to serve /sqlite3.wasm —", e);
      return new Response(`sqlite3.wasm unavailable: ${e}`, { status: 500 });
    }
  }
  const script: Record<string, () => Promise<string>> = {
    "/webui.js": getJs,
    "/sw.js": getSw,
    "/db-worker.js": getDbWorker,
    "/mh-runtime.js": getRuntime,
    "/metahub-sdk.js": getSdk,
  };
  const getter = script[pathname];
  if (getter) {
    try {
      return asset(await getter(), "text/javascript; charset=utf-8");
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
