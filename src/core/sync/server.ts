import { openMetahub } from "../db.ts";
import { getNodeId } from "../node.ts";
import pkg from "../../../package.json" with { type: "json" };
import { routes, type RouteCtx } from "./routes.ts";
import { buildOpenApi } from "./openapi.ts";

export interface RunningServer {
  server: ReturnType<typeof Bun.serve>;
  node: string;
  port: number;
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
export function startServer(opts: { port?: number } = {}): RunningServer {
  const db = openMetahub();
  const node = getNodeId(db);
  const ctx: RouteCtx = { db, node };

  const server = Bun.serve({
    port: opts.port ?? 7777,
    async fetch(req) {
      const url = new URL(req.url);

      // Auto-generated API docs.
      if (req.method === "GET" && url.pathname === "/docs.json") {
        return Response.json(buildOpenApi(pkg.version));
      }
      if (req.method === "GET" && url.pathname === "/docs") {
        return new Response(scalarHtml("/docs.json"), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      // Browser WebUI at `/`. Imported lazily so neither it nor the Preact
      // bundle ever loads on the CLI startup path — only when a browser asks.
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/webui.js")) {
        const { serveWebui } = await import("./webui.ts");
        const res = await serveWebui(req);
        if (res) return res;
      }

      // Registered API routes.
      const route = routes.find((r) => r.method === req.method && r.path === url.pathname);
      if (route) return route.handler(req, ctx);

      return new Response("not found", { status: 404 });
    },
  });
  return { server, node, port: server.port ?? opts.port ?? 7777 };
}
