// Service worker for the WebUI PWA. Built standalone (the api-map import is
// inlined by the bundler; no exports) so the bundle stays a plain classic
// script — registered without `type: "module"`, which keeps older Safari happy.
//
// Roles:
//   1. Offline shell: network-first (short timeout) with versioned cache for
//      "/" navigations, the app bundles, manifest, icons. Network-first keeps
//      the dev rebuild-on-refresh loop and "online means newest"; offline
//      falls back to the last good copy.
//   2. Offline gateway: when a /api/* or /sites/* request can't reach the
//      server, route it to this device's local replica — the SW can't host
//      SQLite itself (OPFS sync handles are dedicated-worker-only), so it
//      forwards `{kind:"mh-rpc"}` messages to a page client; the replica bus
//      in the page answers from whichever tab owns the DB worker.
//   3. Cold-start bootstrap: an offline navigation to a site with NO open
//      client to answer gets a tiny shell that loads /mh-runtime.js and pulls
//      the real HTML out of the replica itself (the shell page becomes the
//      client that answers its own subresource requests).
//
// VERSION is interpolated by the server when serving /sw.js (a hash of the
// current js+css bundle), so any bundle change byte-diffs the worker and
// triggers the update flow; activation drops caches from older versions.

import { mapApiRequest } from "./data/api-map.ts";
import { probeOrigin, type OriginMode } from "./data/origin.ts";

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
  readonly clientId: string;
  respondWith(r: Response | Promise<Response>): void;
}
interface ClientLike {
  id: string;
  postMessage(message: unknown, transfer?: unknown[]): void;
}
interface SwScope {
  caches: CacheStorageLike;
  location: { origin: string };
  skipWaiting(): Promise<void>;
  clients: {
    claim(): Promise<void>;
    get(id: string): Promise<ClientLike | undefined>;
    matchAll(opts?: { type?: string; includeUncontrolled?: boolean }): Promise<ClientLike[]>;
  };
  addEventListener(type: "install" | "activate", fn: (e: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", fn: (e: FetchEventLike) => void): void;
}

const sw = globalThis as unknown as SwScope;
// NOT named `caches`: bundled output declares top-level `var`s, and a global
// `var caches` shadows WorkerGlobalScope.prototype's `caches` getter with an
// own `undefined` property BEFORE the initializer reads it (var hoisting) —
// the worker then dies at evaluation with "undefined.open".
const swCaches = sw.caches;

const VERSION = "__MH_SW_VERSION__";
const SHELL_CACHE = `mh-shell-${VERSION}`;
const API_CACHE = "mh-api-v1"; // survives shell updates; entries overwritten per-URL
// Big and immutable within a dependency version: cache-first in its own cache
// so app updates don't re-download ~1MB of wasm.
const WASM_CACHE = "mh-wasm-v1";

const SHELL_PATHS = [
  "/",
  "/webui.js",
  "/webui.css",
  "/manifest.webmanifest",
  "/db-worker.js",
  "/mh-runtime.js",
];
const NETWORK_TIMEOUT_MS = 3500;
/** Page-client RPC deadline: a cold replica may still be booting wasm. */
const RPC_TIMEOUT_MS = 12_000;

/** The unlock page is a 200 text/html — caching it as the shell would brick
 *  offline starts, so the server marks it and the worker refuses to store it. */
function cacheable(res: Response): boolean {
  return res.ok && res.headers.get("x-mh-unlock") == null;
}

// Is this origin a metahub server, or a data-blind static shell host? When
// there's no server (CDN shell), /api and /sites have no backend — a network
// attempt would 404 (a *response*, not a failure) and mask the local replica,
// so we serve those replica-first instead. Classification (incl. treating a
// transient 5xx as inconclusive, never "none") is shared with the main thread
// via classifyOrigin — see data/origin.ts.
let swOriginMode: OriginMode | null = null;
async function swNoOrigin(): Promise<boolean> {
  if (swOriginMode == null) {
    const mode = await probeOrigin();
    if (mode === "unknown") return false; // inconclusive → assume server, don't cache
    swOriginMode = mode;
  }
  return swOriginMode === "none";
}

sw.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await swCaches.open(SHELL_CACHE);
        // Best-effort warm — a failed fetch must not block installation;
        // runtime network-first traffic repopulates the cache as pages load.
        await Promise.allSettled(
          SHELL_PATHS.map(async (p) => {
            const res = await fetch(p);
            if (cacheable(res)) await cache.put(p, res);
          }),
        );
        await sw.skipWaiting();
      } catch (e) {
        // An install failure silently discards the worker (state → redundant)
        // with no page-visible error; park the reason where a page can read it
        // (caches.match("/__mh-sw-install-error")) before letting it fail.
        try {
          const dbg = await swCaches.open("mh-debug");
          await dbg.put(
            "/__mh-sw-install-error",
            new Response(String((e as Error)?.stack ?? e)),
          );
        } catch {
          /* nothing more we can do */
        }
        throw e;
      }
    })(),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await swCaches.keys()) {
        if (key.startsWith("mh-shell-") && key !== SHELL_CACHE) await swCaches.delete(key);
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
  const cache = await swCaches.open(cacheName);
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

// ---- local replica gateway -------------------------------------------------------

interface RpcReply {
  ok: boolean;
  result?: unknown;
  error?: { message: string; code?: string };
}

/** Ask one page client to run a replica op; replies over a MessagePort. */
function rpcViaClient(client: ClientLike, op: string, args: unknown[]): Promise<RpcReply> {
  return new Promise((resolve, reject) => {
    const mc = new MessageChannel();
    const timer = setTimeout(() => reject(new Error("sw: rpc timeout")), RPC_TIMEOUT_MS);
    mc.port1.onmessage = (e: MessageEvent) => {
      clearTimeout(timer);
      resolve(e.data as RpcReply);
    };
    client.postMessage({ kind: "mh-rpc", op, args }, [mc.port2]);
  });
}

/** Run an op against the local replica via any answering client. The
 *  requesting client goes first (a site page answers for itself); tabs without
 *  an active replica reply code="unavailable" and the next one is tried. */
async function localRpc(event: FetchEventLike, op: string, args: unknown[]): Promise<RpcReply | null> {
  const tried = new Set<string>();
  const candidates: ClientLike[] = [];
  if (event.clientId) {
    const own = await sw.clients.get(event.clientId);
    if (own) candidates.push(own);
  }
  for (const c of await sw.clients.matchAll({ type: "window", includeUncontrolled: true })) {
    if (!candidates.some((x) => x.id === c.id)) candidates.push(c);
  }
  for (const client of candidates) {
    if (tried.has(client.id)) continue;
    tried.add(client.id);
    try {
      const reply = await rpcViaClient(client, op, args);
      if (!reply.ok && reply.error?.code === "unavailable") continue;
      return reply;
    } catch {
      continue; // timeout/port error — try the next client
    }
  }
  return null;
}

/** Same status mapping the HTTP layer uses, so offline error responses look
 *  exactly like server ones to API consumers. */
const CODE_STATUS: Record<string, number> = {
  invalid_input: 400,
  not_found: 404,
  ambiguous: 400,
  stale: 409,
  conflict: 409,
  auth: 401,
  network: 502,
};

function replyToResponse(reply: RpcReply): Response {
  if (reply.ok) {
    return new Response(JSON.stringify(reply.result ?? null), {
      headers: { "content-type": "application/json", "x-mh-source": "replica" },
    });
  }
  const code = reply.error?.code;
  return new Response(JSON.stringify({ error: reply.error?.message ?? "replica error", code }), {
    status: code ? (CODE_STATUS[code] ?? 400) : 502,
    headers: { "content-type": "application/json", "x-mh-source": "replica" },
  });
}

// ---- /api/* gateway ----------------------------------------------------------------

async function handleApi(event: FetchEventLike): Promise<Response> {
  const req = event.request;
  const url = new URL(req.url);

  // Read the body up front: forwarding to the network consumes it, and the
  // local fallback needs the same payload. Non-JSON bodies (site file upload)
  // have no local mapping anyway.
  let body: Record<string, unknown> | null = null;
  if (req.method !== "GET" && (req.headers.get("content-type") ?? "").includes("json")) {
    body = (await req.clone().json().catch(() => null)) as Record<string, unknown> | null;
  }

  // No server behind this origin (data-blind CDN shell): the replica is the only
  // data source — go straight to it instead of letting a CDN 404 mask it.
  if (await swNoOrigin()) {
    const mapped = mapApiRequest(req.method, url.pathname, url.searchParams, body);
    if (mapped) {
      const reply = await localRpc(event, mapped.op, mapped.args);
      if (reply) return replyToResponse(reply);
    }
    return new Response(
      JSON.stringify({ error: "no metahub server (bucket-only mode)", code: "network" }),
      { status: 502, headers: { "content-type": "application/json", "x-mh-source": "replica" } },
    );
  }

  try {
    // GET races a timeout (weak network → replica). Mutations never time out:
    // abandoning an in-flight POST the server may still apply, then applying
    // it locally too, would double-write — only a hard network failure
    // diverts them.
    const res =
      req.method === "GET"
        ? await fetchWithTimeout(req, NETWORK_TIMEOUT_MS * 2)
        : await fetch(req);
    if (req.method === "GET" && cacheable(res)) {
      const cache = await swCaches.open(API_CACHE);
      await cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    const mapped = mapApiRequest(req.method, url.pathname, url.searchParams, body);
    if (mapped) {
      const reply = await localRpc(event, mapped.op, mapped.args);
      if (reply) return replyToResponse(reply);
    }
    if (req.method === "GET") {
      const hit = await (await swCaches.open(API_CACHE)).match(req);
      if (hit) return hit;
    }
    throw err;
  }
}

// ---- /sites/* gateway ---------------------------------------------------------------

function injectRuntime(html: string): string {
  const tag = '<script src="/mh-runtime.js"></script>';
  const i = html.toLowerCase().indexOf("<head>");
  if (i >= 0) return html.slice(0, i + 6) + tag + html.slice(i + 6);
  return tag + html;
}

function siteFileResponse(
  row: { content_type: string; encoding: string; content: string | null },
): Response {
  const isHtml = row.content_type.includes("text/html");
  const content = row.content ?? "";
  let body: string | Uint8Array;
  if (row.encoding === "utf8") body = isHtml ? injectRuntime(content) : content;
  else {
    const bin = atob(content);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    body = bytes;
  }
  return new Response(body as BodyInit, {
    headers: { "content-type": row.content_type, "x-mh-source": "replica" },
  });
}

/** Cold-start shell: an offline navigation with no client able to answer. The
 *  shell loads the runtime, pulls the real HTML out of the replica (this page
 *  IS a client once loaded), and document.writes it in place. */
function bootstrapShell(site: string, path: string): Response {
  const args = `${JSON.stringify(site)},${JSON.stringify(path)}`;
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><script src="/mh-runtime.js"></script></head><body><p style="font:14px system-ui;color:#888;margin:2em">正在从本地副本加载…</p><script>__mhOfflineBootstrap(${args})</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "x-mh-source": "bootstrap" } },
  );
}

/** Serve a /sites/* request from the local replica. Returns null when no client
 *  could answer and it isn't a navigation (caller decides: rethrow or 404). */
async function serveSiteFromReplica(event: FetchEventLike, url: URL): Promise<Response | null> {
  const rest = url.pathname.slice("/sites/".length);
  if (rest === "") return null;
  const slash = rest.indexOf("/");
  if (slash === -1) {
    // /sites/<name> → canonical /sites/<name>/ (same redirect the server does)
    return Response.redirect(`${url.origin}/sites/${rest}/`, 301);
  }
  const name = decodeURIComponent(rest.slice(0, slash));
  const path = decodeURIComponent(rest.slice(slash + 1));

  const reply = await localRpc(event, "siteFile", [name, path]);
  if (reply?.ok && reply.result) {
    return siteFileResponse(reply.result as { content_type: string; encoding: string; content: string | null });
  }
  if (reply?.ok && reply.result == null) {
    return new Response("not found (offline replica)", { status: 404 });
  }
  // No client could answer. For a navigation we can still bootstrap: the shell
  // page itself becomes the answering client.
  if (event.request.mode === "navigate") return bootstrapShell(name, path);
  return null;
}

async function handleSite(event: FetchEventLike): Promise<Response> {
  const req = event.request;
  const url = new URL(req.url);
  // No server behind this origin → the CDN has no /sites; serve replica-first.
  if (await swNoOrigin()) {
    return (await serveSiteFromReplica(event, url)) ?? new Response("not found", { status: 404 });
  }
  try {
    return await fetchWithTimeout(req, NETWORK_TIMEOUT_MS);
  } catch (err) {
    const r = await serveSiteFromReplica(event, url);
    if (r) return r;
    throw err;
  }
}

// ---- dispatch -------------------------------------------------------------------------

sw.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(handleApi(event));
    return;
  }

  if (req.method !== "GET") return;

  if (url.pathname.startsWith("/sites/")) {
    event.respondWith(handleSite(event));
    return;
  }

  // The app is a hash-routed SPA, so only "/" navigations belong to the shell.
  if (req.mode === "navigate") {
    if (url.pathname !== "/") return;
    event.respondWith(networkFirst(req, SHELL_CACHE, NETWORK_TIMEOUT_MS, "/"));
    return;
  }

  if (SHELL_PATHS.includes(url.pathname) || url.pathname.startsWith("/icons/")) {
    event.respondWith(networkFirst(req, SHELL_CACHE, NETWORK_TIMEOUT_MS));
    return;
  }

  if (url.pathname === "/sqlite3.wasm") {
    event.respondWith(
      (async () => {
        const cache = await swCaches.open(WASM_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (cacheable(res)) await cache.put(req, res.clone());
        return res;
      })(),
    );
    return;
  }
});
