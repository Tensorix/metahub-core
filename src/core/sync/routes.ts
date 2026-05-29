import type { ZodType } from "zod";
import type { Database } from "bun:sqlite";
import { ingest, changesAfterSeq } from "../crdt.ts";
import {
  SyncRequestSchema,
  SyncResponseSchema,
  HealthResponseSchema,
  SYNC_PATH,
  HEALTH_PATH,
  type SyncRequest,
} from "./protocol.ts";
import { webuiRoutes } from "./webui-routes.ts";
import { sitesRoutes } from "./sites-routes.ts";

/** Injected at server startup; handlers reuse the open DB connection. */
export interface RouteCtx {
  db: Database;
  node: string;
}

/**
 * One entry per endpoint. `request`/`response` are Zod schemas that double as
 * the OpenAPI source (see ./openapi.ts). Add an endpoint here and it shows up
 * in /docs automatically — no generate step, no separate spec file.
 */
export interface Route {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  request?: ZodType;
  response: ZodType;
  handler: (req: Request, ctx: RouteCtx) => Promise<Response> | Response;
}

const syncRoutes: Route[] = [
  {
    method: "POST",
    path: SYNC_PATH,
    summary: "CRDT replication: push local changes and pull server changes",
    request: SyncRequestSchema,
    response: SyncResponseSchema,
    async handler(req, { db, node }) {
      const body = (await req.json()) as SyncRequest;
      ingest(db, body.changes ?? []);
      const batch = changesAfterSeq(db, body.since ?? 0);
      return Response.json({ node_id: node, changes: batch.changes, cursor: batch.cursor });
    },
  },
  {
    method: "GET",
    path: HEALTH_PATH,
    summary: "Health check",
    response: HealthResponseSchema,
    handler(_req, { node }) {
      return Response.json({ ok: true, node });
    },
  },
];

// CRDT sync protocol routes + the read/write data API the WebUI consumes +
// read-only site endpoints (sites are authored via the `mh site` CLI).
export const routes: Route[] = [...syncRoutes, ...webuiRoutes, ...sitesRoutes];
