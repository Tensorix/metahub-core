// Service worker for the WebUI PWA shell. Built standalone (no imports, no
// exports) so the bundle is a plain classic script — registered without
// `type: "module"`, which keeps older Safari happy.
//
// Strategy (phase 1 — offline shell + read-only mirror):
//   - Shell ("/" navigations, /webui.js, /webui.css, manifest, icons):
//     network-first with a short timeout, falling back to the versioned cache.
//     Network-first (not cache-first) keeps the dev rebuild-on-refresh loop and
//     "online always means newest bundle" semantics; offline still gets the
//     last good shell. Successful responses refresh the cache as they pass.
//   - GET /api/*: network-first, cache fallback — a stale read-only mirror of
//     whatever this browser has seen. Replaced by the local CRDT replica in
//     phase 2; never caches non-GET or non-ok responses.
//   - Everything else (POST, /sync, /auth/*, /sites/*, /docs): untouched.
//
// VERSION is interpolated by the server when serving /sw.js (a hash of the
// current js+css bundle), so any bundle change byte-diffs the worker and
// triggers the update flow; activation drops caches from older versions.

// Local structural types: the project compiles this file under two tsconfigs
// (root: ESNext-only libs; src/webui: DOM libs) and lib.webworker conflicts
// with both, so the worker globals are typed here and reached via globalThis —
// nothing is (re)declared globally.
interface CacheLike {
  match(req: Request | string): Promise<Response | undefined>;
  put(req: Request | string, res: Response): Promise<void>;
}
interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}
interface ExtendableEventLike {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface SwScope {
  caches: CacheStorageLike;
  location: { origin: string };
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", fn: (e: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", fn: (e: FetchEventLike) => void): void;
}

const sw = globalThis as unknown as SwScope;
const caches = sw.caches;

const VERSION = "__MH_SW_VERSION__";
const SHELL_CACHE = `mh-shell-${VERSION}`;
const API_CACHE = "mh-api-v1"; // survives shell updates; entries overwritten per-URL

const SHELL_PATHS = ["/", "/webui.js", "/webui.css", "/manifest.webmanifest"];
const NETWORK_TIMEOUT_MS = 3500;

/** The unlock page is a 200 text/html — caching it as the shell would brick
 *  offline starts, so the server marks it and the worker refuses to store it. */
function cacheable(res: Response): boolean {
  return res.ok && res.headers.get("x-mh-unlock") == null;
}

sw.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Best-effort warm — a failed fetch must not block installation; runtime
      // network-first traffic repopulates the cache as pages load.
      await Promise.allSettled(
        SHELL_PATHS.map(async (p) => {
          const res = await fetch(p);
          if (cacheable(res)) await cache.put(p, res);
        }),
      );
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("mh-shell-") && key !== SHELL_CACHE) await caches.delete(key);
      }
      await sw.clients.claim();
    })(),
  );
});

/** fetch() with a deadline so weak-network loads fall back to cache instead of
 *  hanging; a clean offline failure rejects immediately either way. */
function fetchWithTimeout(req: Request, ms: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sw: network timeout")), ms);
    fetch(req).then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Network-first: refresh the cache on success, fall back to cache on failure.
 *  `cacheKey` normalizes the stored entry (e.g. "/?token=x" caches as "/"). */
async function networkFirst(
  req: Request,
  cacheName: string,
  timeoutMs: number,
  cacheKey?: string,
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const key = cacheKey ?? req;
  try {
    const res = await fetchWithTimeout(req, timeoutMs);
    if (cacheable(res)) await cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

sw.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;

  // The app is a hash-routed SPA, so only "/" navigations belong to the shell.
  // /docs and /sites/* navigations pass through untouched (sites go offline in
  // a later phase, served from the local replica rather than this cache).
  if (req.mode === "navigate") {
    if (url.pathname !== "/") return;
    event.respondWith(networkFirst(req, SHELL_CACHE, NETWORK_TIMEOUT_MS, "/"));
    return;
  }

  if (SHELL_PATHS.includes(url.pathname) || url.pathname.startsWith("/icons/")) {
    event.respondWith(networkFirst(req, SHELL_CACHE, NETWORK_TIMEOUT_MS));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(req, API_CACHE, NETWORK_TIMEOUT_MS * 2));
    return;
  }
});
