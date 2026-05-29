import { z } from "zod";
import type { Route, RouteCtx } from "./routes.ts";
import { listSites, listFiles, resolveSite } from "../sites.ts";

// Read-only site endpoints for the WebUI / served pages. Authoring (create,
// upload, delete) is done through the `mh site` CLI, not over HTTP — these wrap
// the same core functions and are picked up by /docs automatically.

const SiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  created_hlc: z.string(),
});
const SiteFileSchema = z.object({
  id: z.string(),
  site_id: z.string(),
  path: z.string(),
  content_type: z.string(),
  encoding: z.string(),
});

function need(req: Request, key: string): string {
  const v = new URL(req.url).searchParams.get(key);
  if (!v) throw new Error(`missing query param: ${key}`);
  return v;
}

function handle(fn: (req: Request, ctx: RouteCtx) => unknown): Route["handler"] {
  return async (req, ctx) => {
    try {
      return Response.json((await fn(req, ctx)) ?? null);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  };
}

export const sitesRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/sites",
    summary: "List published sites",
    response: z.array(SiteSchema),
    handler: handle((_req, { db }) => listSites(db)),
  },
  {
    method: "GET",
    path: "/api/site/files",
    summary: "List a site's files (manifest). Query: ?site=<id|name>",
    response: z.array(SiteFileSchema),
    handler: handle((req, { db }) => listFiles(db, resolveSite(db, need(req, "site")).id)),
  },
];
