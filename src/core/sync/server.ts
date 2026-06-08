import { openMetahub } from "../db.ts";
import { getNodeId } from "../node.ts";
import { getServerConfig } from "../config.ts";
import pkg from "../../../package.json" with { type: "json" };
import { routes, type RouteCtx } from "./routes.ts";
import { SYNC_PATH, HEALTH_PATH, RENEW_PATH, PAIR_PATH } from "./protocol.ts";
import { DEFAULT_TTL_MS, DEFAULT_GRACE_MS } from "./token.ts";
import { syncAllPeers } from "./peers.ts";
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
  /** Whether the auto-sync timer is running. */
  autoSync: boolean;
  /** Auto-sync poll interval in ms (meaningful only when autoSync). */
  syncIntervalMs: number;
  /** Stop the server and the auto-sync timer. */
  stop: () => void;
}

/** Thrown when the requested port is already taken, so callers can react. */
export class PortInUseError extends Error {
  constructor(
    readonly port: number,
    readonly host: string,
  ) {
    super(
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
          url.pathname === PAIR_PATH;

        // Token gate (no-op in --debug). A browser without a token gets the
        // unlock page; everything else gets 401. Once the unlock page sets the
        // cookie the reload passes here and the real content is served.
        if (!exempt && !hasValidToken(req, url, auth)) {
          return wantsHtml(req)
            ? new Response(unlockPage(), { headers: HTML_HEADERS })
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
        return Response.json(buildOpenApi(pkg.version));
      }
      if (req.method === "GET" && url.pathname === "/docs") {
        return withShim(new Response(scalarHtml("/docs.json"), { headers: HTML_HEADERS }), auth);
      }

      // Browser WebUI at `/`. Imported lazily so neither it nor the Preact
      // bundle ever loads on the CLI startup path — only when a browser asks.
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/webui.js")) {
        const { serveWebui } = await import("./webui.ts");
        const res = await serveWebui(req);
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
      const route = routes.find((r) => r.method === req.method && r.path === url.pathname);
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
      throw new Error(
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
    timer = setInterval(() => {
      // Per-peer errors are already recorded in the DB (last_error) by syncPeer
      // and surfaced via CLI/WebUI, so we don't re-log those every tick. This
      // catch only covers an *unexpected* tick crash, which would otherwise be
      // wholly silent.
      void syncAllPeers(db).catch((e) => console.error("[sync] auto-sync tick failed —", e));
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
    autoSync: Boolean(autoSync && syncIntervalMs > 0),
    syncIntervalMs,
    stop() {
      if (timer) clearInterval(timer);
      server.stop();
    },
  };
}
