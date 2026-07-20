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
import { sitesRoutes } from "./sites-routes.ts";
import { peersRoutes } from "./peers-routes.ts";
import { blobRoutes } from "./blob-routes.ts";
import { errorCode, type MhErrorCode } from "../errors.ts";

/** Injected at server startup; handlers reuse the open DB connection. */
export interface RouteCtx {
  db: Database;
  node: string;
  /** Desktop's unauthenticated loopback sidecar may preview locally but must
   *  never be accepted as a LAN/public hosting origin. */
  allowRemoteSiteHosting?: boolean;
}

/** HTTP status per error code (see core/errors.ts). Uncategorized errors stay
 *  400, matching the historical catch-all behavior. */
const HTTP_STATUS: Record<MhErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  ambiguous: 400,
  stale: 409,
  conflict: 409,
  auth: 401,
  network: 502,
  rate_limited: 429,
  port_in_use: 500,
};

/** Turn a thrown handler error into a JSON response: `{error, code?}` with a
 *  semantic status, so HTTP clients can dispatch on `code` like CLI users
 *  dispatch on exit codes. */
export function errorResponse(e: unknown): Response {
  const message = e instanceof Error ? e.message : String(e);
  const code = errorCode(e);
  return Response.json(code ? { error: message, code } : { error: message }, {
    status: code ? HTTP_STATUS[code] : 400,
  });
}

/**
 * One entry per endpoint. `request`/`response` are Zod schemas that double as
 * the OpenAPI source (see ./openapi.ts). Add an endpoint here and it shows up
 * in /docs automatically — no generate step, no separate spec file.
 */
export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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
      const batch = changesAfterSeq(db, body.since ?? 0, {
        limit: body.limit,
        excludeDatasets: body.exclude_datasets,
      });
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

// CRDT sync protocol routes + read-only site endpoints (sites are authored via
// the `mh site` CLI) + peer pairing/management endpoints. The WebUI's data API
// is not part of core: it is injected via startServer's `ui` option.
export const routes: Route[] = [...syncRoutes, ...sitesRoutes, ...peersRoutes, ...blobRoutes];
