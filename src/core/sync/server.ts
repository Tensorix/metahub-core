import "./storage-s3-bun.ts"; // side effect: register the Bun S3 storage-sync client (auto-sync timer)
import { openMetahub } from "../db.ts";
import { MhError } from "../errors.ts";
import { getNodeId } from "../node.ts";
import { getServerConfig } from "../config.ts";
import pkg from "../../../package.json" with { type: "json" };
import { routes, type Route, type RouteCtx } from "./routes.ts";
import { SYNC_PATH, HEALTH_PATH, RENEW_PATH, PAIR_PATH } from "./protocol.ts";
import { DEFAULT_TTL_MS, DEFAULT_GRACE_MS } from "./token.ts";
import { syncPeer, listPeers } from "./peers.ts";
import { getEdgeConfig } from "./edge-config.ts";
import { blobMaintenance, resolveBlob } from "../blobs.ts";
import { registerRoomBlobResolver } from "./room-peer.ts";
import { buildOpenApi } from "./openapi.ts";
import {
  type AuthConfig,
  activeToken,
  hasValidToken,
  acceptsSyncToken,
  renewToken,
  wantsHtml,
  unlockPage,
  withShim,
  unauthorized,
  HTML_HEADERS,
} from "./auth.ts";

export interface RunningServer {
  server: ReturnType<typeof Bun.serve>;
  node: string;
  port: number;
  /** Resolved bind address (loopback unless explicitly exposed). */
  host: string;
  /** The active token, or null in --debug mode (auth disabled). */
  token: string | null;
  /** Token expiry (epoch ms); Infinity for a static --token, null when auth is off. */
  exp: number | null;
  /** How the token was sourced: rotating (managed), fixed (static), or off (disabled). */
  authMode: "managed" | "static" | "disabled";
  /** Whether the server terminates TLS itself (URLs are https://). */
  tls: boolean;
  /** Whether the auto-sync timer is running. */
  autoSync: boolean;
  /** Auto-sync poll interval in ms (meaningful only when autoSync). */
  syncIntervalMs: number;
  /** Stop the server and the auto-sync timer. */
  stop: () => void;
}

/** Thrown when the requested port is already taken, so callers can react. */
export class PortInUseError extends MhError {
  constructor(
    readonly port: number,
    readonly host: string,
  ) {
    super(
      "port_in_use",
      `port ${port} is already in use — another mh server may be running. ` +
        `Stop it, or start on a free port with --port <n>.`,
    );
    this.name = "PortInUseError";
  }
}

export interface ServerOptions {
  port?: number;
  /** Bind address. Defaults to 127.0.0.1; pass "0.0.0.0" to expose. */
  host?: string;
  /** Disable auth entirely. */
  debug?: boolean;
  /** Custom token. If omitted in non-debug mode, one is generated. */
  token?: string;
  /** Auto-sync poll interval in ms; <= 0 disables it. Falls back to stored config. */
  syncIntervalMs?: number;
  /** Master switch for the auto-sync timer. Falls back to stored config. */
  autoSync?: boolean;
  /** Disable LAN/public site-base verification for an unauthenticated
   *  loopback-only shell such as the Desktop sidecar. */
  allowRemoteSiteHosting?: boolean;
  /** Desktop's debug sidecar: reject DNS-rebinding hosts and cross-site
   * mutations even though the token gate is intentionally disabled. */
  loopbackUiOnly?: boolean;
  /** Browser UI plug-in point. Core ships no UI; callers (CLI, desktop
   *  sidecar) inject the WebUI's asset handler + data API routes here.
   *  Omitted = a headless sync/sites server. */
  ui?: UiHandler;
  /** Optional TLS (PEM file paths). When set the server terminates TLS itself
   *  and serves https — service workers/PWA need a secure context off
   *  localhost. A reverse proxy (Caddy, Tailscale Serve) in front is the
   *  recommended alternative; this is for setups without one. */
  tls?: { certPath: string; keyPath: string };
}

/** What a pluggable browser UI provides (see src/webui/server/). */
export interface UiHandler {
  /** Serve UI assets (GET / , /webui.js, /webui.css); null = not a UI asset. */
  serveAssets(req: Request): Promise<Response | null>;
  /** The UI's data API routes, merged into the route registry (and /docs). */
  routes: Route[];
}

export function loopbackUiRejection(req: Request, port: number): Response | null {
  const url = new URL(req.url);
  const actualPort = String(port);
  if (url.hostname !== "127.0.0.1" || url.port !== actualPort)
    return new Response("forbidden host", { status: 403 });
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return null;
  const expectedOrigin = `http://127.0.0.1:${actualPort}`;
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");
  if (
    origin !== expectedOrigin ||
    (fetchSite != null && fetchSite !== "same-origin" && fetchSite !== "none")
  )
    return new Response("cross-site mutation denied", { status: 403 });
  return null;
}

/** Scalar API reference UI, loaded from CDN — no bundling or npm dependency. */
function scalarHtml(specUrl: string): string {
  return `<!doctype html><html><head>
<meta charset="utf-8"><title>Metahub API</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><script id="api-reference" data-url="${specUrl}"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body></html>`;
}

/** Start the CRDT sync server. It is just another node backed by ~/.metahub. */
export function startServer(opts: ServerOptions = {}): RunningServer {
  registerRoomBlobResolver(resolveBlob);
  const db = openMetahub();
  const node = getNodeId(db);
  const ctx: RouteCtx = {
    db,
    node,
    allowRemoteSiteHosting: opts.allowRemoteSiteHosting ?? true,
  };
  const allRoutes = opts.ui ? [...routes, ...opts.ui.routes] : routes;

  // In-process forward into the route table for /sites/<name>/api/* requests
  // that carry a valid token: the site mount rewrites the URL to /api/* and the
  // request is dispatched exactly like a top-level API call (see sites-serve.ts).
  const forwardApi = async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    const route = allRoutes.find((r) => r.method === req.method && r.path === path);
    return route ? route.handler(req, ctx) : new Response("not found", { status: 404 });
  };

  // Resolve runtime settings: explicit opts (CLI flags) override stored config.
  const cfg = getServerConfig(db);
  const port = opts.port ?? cfg.port;
  const host = opts.host ?? cfg.host;
  const syncIntervalMs = opts.syncIntervalMs ?? cfg.syncIntervalMs;
  const autoSync = opts.autoSync ?? cfg.autoSync;

  // Three modes: --debug disables auth; an explicit --token/env is a fixed,
  // non-persisted token; otherwise a persistent, rotating token from ~/.metahub.
  const auth: AuthConfig = opts.debug
    ? { debug: true, staticToken: null, db: null, ttlMs: 0, graceMs: 0 }
    : opts.token
      ? { debug: false, staticToken: opts.token, db: null, ttlMs: 0, graceMs: 0 }
      : {
          debug: false,
          staticToken: null,
          db,
          ttlMs: DEFAULT_TTL_MS,
          graceMs: DEFAULT_GRACE_MS,
        };

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
    port,
    hostname: host,
    tls: opts.tls
      ? { cert: Bun.file(opts.tls.certPath), key: Bun.file(opts.tls.keyPath) }
      : undefined,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (opts.loopbackUiOnly) {
        const rejection = loopbackUiRejection(req, srv.port!);
        if (rejection) return rejection;
      }

      // Client IP for the guest-surface rate limiters: first x-forwarded-for hop
      // (reverse-proxy deployments) over the socket address. Best-effort — a
      // missing address degrades to one shared bucket, never an open gate.
      const clientIp =
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        srv.requestIP(req)?.address ||
        null;

      // /sync now requires the master token OR a per-peer grant from pairing
      // (the old open trusted-peer model is gone; pairing distributes the
      // credentials — see ./pairing.ts, acceptsSyncToken). /health and
      // /auth/token stay open (the latter must work with an expired token), and
      // the pairing handshake authenticates via its one-time code in-handler.
      // Share management a paired peer may drive remotely (create on / list from /
      // revoke on this node): authorized by the master token OR a pairing grant,
      // like /sync. EXACT paths only — /api/share/servers|buckets|renew (peer/bucket
      // inventory + re-presign) stay master-only via the else branch below.
      const shareMgmt =
        ((req.method === "POST" || req.method === "DELETE") && url.pathname === "/api/share") ||
        (req.method === "GET" && url.pathname === "/api/shares") ||
        ((req.method === "GET" || req.method === "DELETE") &&
          url.pathname === "/api/share/request");
      if (
        url.pathname === SYNC_PATH ||
        url.pathname.startsWith("/blob/") ||
        url.pathname === "/api/blobs/has" ||
        shareMgmt
      ) {
        // /blob/<hash> byte transport (and /api/blobs/has presence probe) authorize
        // like /sync: the master token OR a per-peer grant (a paired peer fetching a
        // blob it only has the hash of, or asking whether this node holds hashes).
        if (!acceptsSyncToken(req, url, auth, db)) return unauthorized();
      } else {
        const exempt =
          url.pathname === HEALTH_PATH ||
          url.pathname === RENEW_PATH ||
          url.pathname === PAIR_PATH ||
          // PWA install metadata + the worker script: browsers fetch these
          // without credentials, and they carry nothing sensitive (app name,
          // icons, generic caching code), so they sit outside the token gate.
          url.pathname === "/manifest.webmanifest" ||
          url.pathname === "/sw.js" ||
          // The typed data SDK module: public share/site pages import it, and it
          // carries nothing sensitive (generic client code, no token) — same
          // reasoning as /sw.js.
          url.pathname === "/metahub-sdk.js" ||
          url.pathname.startsWith("/icons/") ||
          // Public shares enforce their own per-share access control (slug +
          // expiry + optional password) inside serveShare — never the master
          // token. See ./share-serve.ts.
          url.pathname.startsWith("/share/") ||
          // Sites run their own per-site access decision (visibility:public →
          // token-free; otherwise serveSite re-runs the token gate itself,
          // answering private and nonexistent identically). See ./sites-serve.ts.
          url.pathname.startsWith("/sites/");

        // Token gate (no-op in --debug). A browser without a token gets the
        // unlock page; everything else gets 401. Once the unlock page sets the
        // cookie the reload passes here and the real content is served.
        if (!exempt && !hasValidToken(req, url, auth)) {
          return wantsHtml(req)
            ? // x-mh-unlock tells the service worker this 200 is the unlock
              // page, not the app shell — caching it would brick offline starts.
              new Response(unlockPage(), { headers: { ...HTML_HEADERS, "x-mh-unlock": "1" } })
            : unauthorized();
        }
      }

      // Seamless renewal: swap the current (or in-grace previous) token for the
      // current token + expiry. 401 if the presented token isn't recognized.
      if (url.pathname === RENEW_PATH) {
        const r = renewToken(req, url, auth);
        return r ? Response.json(r) : unauthorized();
      }

      // Auto-generated API docs.
      if (req.method === "GET" && url.pathname === "/docs.json") {
        return Response.json(buildOpenApi(pkg.version, allRoutes));
      }
      if (req.method === "GET" && url.pathname === "/docs") {
        return withShim(new Response(scalarHtml("/docs.json"), { headers: HTML_HEADERS }), auth, req, url);
      }

      // Injected browser UI assets (core itself ships no UI).
      if (req.method === "GET" && opts.ui) {
        const res = await opts.ui.serveAssets(req);
        if (res) return withShim(res, auth, req, url);
      }

      // Agent-published static sites at /sites/<name>/<path...>. Lazy-imported
      // for the same zero-startup-cost reason as the WebUI. Autonomous: it
      // token-gates private sites itself and injects the runtime only for
      // authenticated HTML (public pages are returned RAW — same red line as
      // /share/ below), so no withShim here.
      if (url.pathname.startsWith("/sites/")) {
        // Any method: /sites/<name>/api/* accepts POST/PATCH (grant-scoped guest
        // writes, or the in-process forward below for token holders). File
        // serving inside serveSite stays GET-shaped as before.
        const isApi = /^\/sites\/[^/]+\/api(\/|$)/.test(url.pathname);
        if (req.method === "GET" || isApi) {
          const { serveSite } = await import("./sites-serve.ts");
          const res = await serveSite(req, ctx, auth, { ip: clientIp, forwardApi });
          if (res) return res;
        }
      }

      // Content-addressed blob bytes at /blob/<hash>[.ext] (document images /
      // large files). Resolves on demand (local → peers → bucket); raw bytes, no
      // shim. See blob-routes.ts / blobs.ts.
      if (req.method === "GET" && url.pathname.startsWith("/blob/")) {
        const { serveBlob } = await import("./blob-routes.ts");
        const res = await serveBlob(req, ctx);
        if (res) return res;
      }

      // Public capability shares at /share/<slug>... (any method — edit shares
      // accept writes). Per-share access control lives in serveShare; responses
      // are returned RAW (never withShim) so a public page never carries the
      // master-token runtime. Lazy-imported like the other off-startup handlers.
      if (url.pathname.startsWith("/share/")) {
        const { serveShare } = await import("./share-serve.ts");
        const res = await serveShare(req, ctx, { ip: clientIp });
        if (res) return res;
      }

      // Registered API routes.
      const route = allRoutes.find((r) => r.method === req.method && r.path === url.pathname);
      if (route) return route.handler(req, ctx);

      return new Response("not found", { status: 404 });
    },
    });
  } catch (e) {
    // Bun.serve throws synchronously on a bind failure. Turn the raw EADDRINUSE
    // (and the related EACCES) into an actionable message instead of a stack
    // trace pointing into the framework.
    const code = (e as { code?: string } | null)?.code;
    if (code === "EADDRINUSE") {
      throw new PortInUseError(port, host);
    }
    if (code === "EACCES") {
      throw new MhError(
        "invalid_input",
        `permission denied binding ${host}:${port} — ports below 1024 need elevated privileges; pick a higher port with --port`,
      );
    }
    throw e;
  }
  // Auto-sync timer: each tick runs one push/pull round against every enabled
  // peer. The DB is the source of truth, so peers added by `mh config` (a
  // separate process) are picked up on the next tick without a restart.
  let timer: ReturnType<typeof setInterval> | null = null;
  if (autoSync && syncIntervalMs > 0) {
    // Shared idle backoff for every METERED remote round — s3 bucket polls,
    // room (Durable Object) syncs, and the write-inbox pull all use one map:
    // when the hub hasn't advanced (no local edit, nothing pulled) and a
    // round keeps coming up empty, its cadence doubles, capped at 2.5min
    // (≈ publisher-lease TTL/2 so lease failover stays timely). Any hub
    // advance (a local edit OR a pulled remote edit) reclaims the base
    // cadence so propagation stays prompt. http peers sync every tick.
    const IDLE_BACKOFF_MAX_MS = 150_000; // 2.5min
    const idleNext = new Map<string, { delay: number; due: number }>();
    /** Whether `key` is due this tick, honoring its current backoff. */
    const dueNow = (key: string, advanced: boolean, now: number): boolean => {
      const st = idleNext.get(key);
      return advanced || !st || now >= st.due;
    };
    /** Record a round's outcome: busy → base cadence, idle → doubled delay. */
    const recordRound = (key: string, busy: boolean, baseMs: number): void => {
      const st = idleNext.get(key);
      const delay = busy ? baseMs : Math.min((st?.delay ?? baseMs) * 2, IDLE_BACKOFF_MAX_MS);
      idleNext.set(key, { delay, due: Date.now() + delay });
    };
    let lastMaxSeq = -1;
    let ticking = false;
    // Blob upkeep is metered separately from the oplog poll: a full-blob device
    // pulls/announces referenced blobs and pushes held blobs to buckets. Runs at
    // most once a minute regardless of the (possibly faster) sync cadence.
    const BLOB_MAINT_MS = 60_000;
    let lastBlobMaint = 0;
    // Write-inbox pull cadence: base 60s (its own base — the edge poll is a
    // metered cost), then the shared idle backoff above. Runs AFTER the peers
    // loop so the bucket push round precedes the drop round each tick and the
    // ack gate (seqAtIngest ≤ push_cursor) can pass.
    const DROP_POLL_BASE_MS = 60_000;
    const DROP_KEY = " drop"; // never collides with a peers.url
    const tick = async (): Promise<void> => {
      const maxSeq =
        (db.query("SELECT MAX(seq) AS s FROM crdt_changes").get() as { s: number | null }).s ?? 0;
      const advanced = lastMaxSeq >= 0 && maxSeq > lastMaxSeq;
      lastMaxSeq = maxSeq;
      const now = Date.now();
      for (const p of listPeers(db)) {
        if (!p.enabled) continue;
        if (p.kind !== "s3" && p.kind !== "room") {
          await syncPeer(db, p.url);
          continue;
        }
        if (!dueNow(p.url, advanced, now)) continue; // idle & backed off → not due
        const out = await syncPeer(db, p.url);
        recordRound(p.url, advanced || (out.pushed ?? 0) > 0 || (out.pulled ?? 0) > 0, syncIntervalMs);
      }
      if (getEdgeConfig(db) && dueNow(DROP_KEY, false, Date.now())) {
        let busy = false;
        try {
          // Lazy import: the drop pipeline stays off the startup path (and out
          // of memory entirely) until an edge is actually configured.
          const { pullDropsOnce } = await import("./drop-pull.ts");
          const r = await pullDropsOnce(db);
          busy = r.ingested > 0 || r.acked > 0;
        } catch (e) {
          console.error("[drop] inbox pull failed —", e);
        }
        recordRound(DROP_KEY, busy, DROP_POLL_BASE_MS);
      }
      if (Date.now() - lastBlobMaint >= BLOB_MAINT_MS) {
        lastBlobMaint = Date.now();
        try {
          await blobMaintenance(db);
        } catch (e) {
          console.error("[blob] maintenance failed —", e);
        }
      }
    };
    timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      // Per-peer errors are already recorded in the DB (last_error) by syncPeer and
      // surfaced via CLI/WebUI; this catch only covers an *unexpected* tick crash.
      void tick()
        .catch((e) => console.error("[sync] auto-sync tick failed —", e))
        .finally(() => {
          ticking = false;
        });
    }, syncIntervalMs);
    timer.unref?.();
  }

  const active = activeToken(auth);
  const authMode: RunningServer["authMode"] = opts.debug
    ? "disabled"
    : opts.token
      ? "static"
      : "managed";
  return {
    server,
    node,
    port: server.port ?? port,
    host,
    token: active?.token ?? null,
    exp: active?.exp ?? null,
    authMode,
    tls: Boolean(opts.tls),
    autoSync: Boolean(autoSync && syncIntervalMs > 0),
    syncIntervalMs,
    stop() {
      if (timer) clearInterval(timer);
      server.stop();
    },
  };
}
