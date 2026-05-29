import { openMetahub } from "../db.ts";
import { getNodeId } from "../node.ts";
import { randomSuffix } from "../ids.ts";
import pkg from "../../../package.json" with { type: "json" };
import { routes, type RouteCtx } from "./routes.ts";
import { SYNC_PATH, HEALTH_PATH } from "./protocol.ts";
import { buildOpenApi } from "./openapi.ts";
import {
  type AuthConfig,
  hasValidToken,
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
  /** The active token, or null in --debug mode (auth disabled). */
  token: string | null;
}

export interface ServerOptions {
  port?: number;
  /** Bind address. Defaults to 127.0.0.1; pass "0.0.0.0" to expose. */
  host?: string;
  /** Disable auth entirely. */
  debug?: boolean;
  /** Custom token. If omitted in non-debug mode, one is generated. */
  token?: string;
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

  const auth: AuthConfig = {
    debug: opts.debug ?? false,
    token: opts.debug ? null : (opts.token ?? randomSuffix(24)),
  };

  const server = Bun.serve({
    port: opts.port ?? 7777,
    hostname: opts.host ?? "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      // CRDT replication keeps its prior trusted-peer model: /sync and /health
      // are exempt from the token gate so `mh sync` works without distributing
      // the token to peers. Everything else (WebUI, /api/*, /docs, /sites) is gated.
      const exempt = url.pathname === SYNC_PATH || url.pathname === HEALTH_PATH;

      // Token gate (no-op in --debug). A browser without a token gets the unlock
      // page; everything else gets 401. Once the unlock page sets the cookie the
      // reload passes here and the real content (with fetch shim) is served.
      if (!exempt && !hasValidToken(req, url, auth)) {
        return wantsHtml(req)
          ? new Response(unlockPage(), { headers: HTML_HEADERS })
          : unauthorized();
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
  return { server, node, port: server.port ?? opts.port ?? 7777, token: auth.token };
}
