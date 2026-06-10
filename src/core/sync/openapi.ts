import { z } from "zod";
import { routes as coreRoutes, type Route } from "./routes.ts";

/**
 * Build an OpenAPI 3.1 document by walking a route registry. Each route's
 * Zod schemas are converted to JSON Schema (draft 2020-12, which 3.1 accepts).
 * Adding a route to ./routes.ts is enough — this picks it up with no codegen.
 * The server passes its full registry (core + injected UI routes) so /docs
 * always matches what is actually served.
 */
export function buildOpenApi(version: string, routes: readonly Route[] = coreRoutes) {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const op: Record<string, unknown> = {
      summary: route.summary,
      responses: {
        "200": {
          description: "OK",
          content: { "application/json": { schema: z.toJSONSchema(route.response) } },
        },
      },
    };
    if (route.request) {
      op.requestBody = {
        required: true,
        content: { "application/json": { schema: z.toJSONSchema(route.request) } },
      };
    }
    (paths[route.path] ??= {})[route.method.toLowerCase()] = op;
  }

  return {
    openapi: "3.1.0",
    info: { title: "Metahub Sync API", version },
    paths,
  };
}
