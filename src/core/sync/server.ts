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
  const db = openMetahub();
  const node = getNodeId(db);
  const ctx: RouteCtx = { db, node };
  const allRoutes = opts.ui ? [...routes, ...opts.ui.routes] : routes;

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
    async fetch(req) {
      const url = new URL(req.url);

      // /sync now requires the master token OR a per-peer grant from pairing
      // (the old open trusted-peer model is gone; pairing distributes the
      // credentials — see ./pairing.ts, acceptsSyncToken). /health and
      // /auth/token stay open (the latter must work with an expired token), and
      // the pairing handshake authenticates via its one-time code in-handler.
      if (url.pathname === SYNC_PATH) {
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
          url.pathname.startsWith("/icons/");

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
        return withShim(new Response(scalarHtml("/docs.json"), { headers: HTML_HEADERS }), auth);
      }

      // Injected browser UI assets (core itself ships no UI).
      if (req.method === "GET" && opts.ui) {
        const res = await opts.ui.serveAssets(req);
        if (res) return withShim(res, auth);
      }

      // Agent-published static sites at /sites/<name>/<path...>. Lazy-imported
      // for the same zero-startup-cost reason as the WebUI.
      if (req.method === "GET" && url.pathname.startsWith("/sites/")) {
        const { serveSite } = await import("./sites-serve.ts");
        const res = await serveSite(req, ctx);
        if (res) return withShim(res, auth);
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
    // Per-peer idle backoff for storage (s3) peers — the bucket poll is the metered
    // cost. When the hub hasn't advanced (no local edit, nothing pulled) and a
    // peer's rounds keep coming up empty, slow it down, capped at TTL/2 so the
    // publisher lease / failover stay timely. Any hub advance (a local edit OR a
    // pulled remote edit) reclaims the base cadence so propagation stays prompt.
    // http peers sync every tick.
    const S3_POLL_MAX_MS = 150_000; // 2.5min ≈ publisher-lease TTL/2
    const s3Next = new Map<string, { delay: number; due: number }>();
    let lastMaxSeq = -1;
    const tick = async (): Promise<void> => {
      const maxSeq =
        (db.query("SELECT MAX(seq) AS s FROM crdt_changes").get() as { s: number | null }).s ?? 0;
      const advanced = lastMaxSeq >= 0 && maxSeq > lastMaxSeq;
      lastMaxSeq = maxSeq;
      const now = Date.now();
      for (const p of listPeers(db)) {
        if (!p.enabled) continue;
        if (p.kind !== "s3") {
          await syncPeer(db, p.url);
          continue;
        }
        const st = s3Next.get(p.url);
        if (!advanced && st && now < st.due) continue; // idle & backed off → not due
        const out = await syncPeer(db, p.url);
        const busy = advanced || (out.pushed ?? 0) > 0 || (out.pulled ?? 0) > 0;
        const delay = busy
          ? syncIntervalMs
          : Math.min((st?.delay ?? syncIntervalMs) * 2, S3_POLL_MAX_MS);
        s3Next.set(p.url, { delay, due: Date.now() + delay });
      }
    };
    timer = setInterval(() => {
      // Per-peer errors are already recorded in the DB (last_error) by syncPeer and
      // surfaced via CLI/WebUI; this catch only covers an *unexpected* tick crash.
      void tick().catch((e) => console.error("[sync] auto-sync tick failed —", e));
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
