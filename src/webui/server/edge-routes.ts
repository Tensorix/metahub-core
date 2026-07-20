import { z } from "zod";
import { type Route } from "../../core/sync/routes.ts";
import {
  connectEdge,
  deployEdge,
  disconnectEdge,
  edgeStatus,
  type EdgeDeployInput,
} from "../../core/sync/edge-service.ts";
import { getEdgeWorkerScript } from "../../cli/edge-worker-script.ts";
import { jsonHandler } from "./json-handler.ts";

const EdgeStatusSchema = z.any();
const EdgeDeploySchema = z.object({
  accountId: z.string(),
  apiToken: z.string(),
  workerName: z.string().optional(),
  d1Name: z.string().optional(),
  workersSubdomain: z.string().optional(),
  confirmed: z.boolean(),
});
const EdgeConnectSchema = z.object({ endpoint: z.string(), token: z.string() });

export const edgeRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/edge",
    summary: "Edge endpoint health, version, deployment progress and rooms.",
    response: EdgeStatusSchema,
    handler: jsonHandler((_req, { db }) => edgeStatus(db)),
  },
  {
    method: "POST",
    path: "/api/edge/deploy",
    summary: "Create/upgrade a dedicated Cloudflare Worker and D1 after explicit confirmation.",
    request: EdgeDeploySchema,
    response: z.any(),
    handler: jsonHandler(async (req, { db }) => {
      const body = EdgeDeploySchema.parse(await req.json()) as EdgeDeployInput;
      return deployEdge(db, body, await getEdgeWorkerScript());
    }),
  },
  {
    method: "PUT",
    path: "/api/edge/connect",
    summary: "Connect this node to an existing compatible Edge endpoint.",
    request: EdgeConnectSchema,
    response: EdgeStatusSchema,
    handler: jsonHandler(async (req, { db }) => {
      const body = EdgeConnectSchema.parse(await req.json());
      return connectEdge(db, body.endpoint, body.token);
    }),
  },
  {
    method: "DELETE",
    path: "/api/edge",
    summary: "Forget local Edge configuration; refused while rooms are active.",
    response: z.object({ ok: z.boolean() }),
    handler: jsonHandler((_req, { db }) => {
      disconnectEdge(db);
      return { ok: true };
    }),
  },
];
