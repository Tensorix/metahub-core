import { z } from "zod";
import type { Route, RouteCtx } from "./routes.ts";
import {
  listSites,
  listFiles,
  resolveSite,
  createSite,
  updateSite,
  deleteSite,
  putFile,
  deleteFile,
} from "../sites.ts";

// Site endpoints for the WebUI / served pages. Reads (list sites/files) and
// authoring (create, rename, delete, upload) both wrap the same core functions
// the `mh site` CLI uses, so changes ride the CRDT oplog and replicate over
// /sync. All routes are gated by the server's master-token middleware.

const SiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  created_hlc: z.string(),
});
const SiteWithCountSchema = SiteSchema.extend({ file_count: z.number() });
const SiteFileSchema = z.object({
  id: z.string(),
  site_id: z.string(),
  path: z.string(),
  content_type: z.string(),
  encoding: z.string(),
});
// Request bodies — used both for the OpenAPI doc and to .parse() at runtime so a
// malformed body is a clean 400 rather than an `as`-cast lie. Semantic rules
// (slug/path shape) live in core (normalizeSiteName/normalizeSitePath).
const CreateSiteBody = z.object({ name: z.string(), title: z.string().optional() });
const UpdateSiteBody = z.object({ name: z.string().optional(), title: z.string().optional() });

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
    summary: "List published sites (with file counts)",
    response: z.array(SiteWithCountSchema),
    handler: handle((_req, { db }) =>
      listSites(db).map((s) => ({ ...s, file_count: listFiles(db, s.id).length })),
    ),
  },
  {
    method: "GET",
    path: "/api/site/files",
    summary: "List a site's files (manifest). Query: ?site=<id|name>",
    response: z.array(SiteFileSchema),
    handler: handle((req, { db }) => listFiles(db, resolveSite(db, need(req, "site")).id)),
  },
  {
    method: "POST",
    path: "/api/sites",
    summary: "Create a site",
    request: CreateSiteBody,
    response: SiteSchema,
    handler: handle(async (req, { db }) => {
      const body = CreateSiteBody.parse(await req.json());
      return createSite(db, body);
    }),
  },
  {
    method: "PATCH",
    path: "/api/site",
    summary: "Rename a site or change its title. Query: ?id=<id>",
    request: UpdateSiteBody,
    response: SiteSchema,
    handler: handle(async (req, { db }) => {
      const body = UpdateSiteBody.parse(await req.json());
      return updateSite(db, need(req, "id"), body);
    }),
  },
  {
    method: "DELETE",
    path: "/api/site",
    summary: "Delete a site and its files. Query: ?id=<id>",
    response: z.object({ ok: z.boolean() }),
    handler: handle((req, { db }) => ({ ok: deleteSite(db, need(req, "id")) })),
  },
  {
    method: "POST",
    path: "/api/site/file",
    summary: "Upload/replace a file. Query: ?site=<id|name>&path=<path>; body is raw bytes",
    response: SiteFileSchema,
    handler: handle(async (req, { db }) => {
      const site = resolveSite(db, need(req, "site"));
      // Fall back to path-based inference when the browser sends no/generic type.
      const ct = req.headers.get("content-type");
      const file = await putFile(db, site.id, need(req, "path"), {
        data: await req.arrayBuffer(),
        contentType: ct && ct !== "application/octet-stream" ? ct : undefined,
      });
      const { content: _content, ...summary } = file;
      return summary;
    }),
  },
  {
    method: "DELETE",
    path: "/api/site/file",
    summary: "Delete a file. Query: ?site=<id|name>&path=<path>",
    response: z.object({ ok: z.boolean() }),
    handler: handle((req, { db }) => ({
      ok: deleteFile(db, resolveSite(db, need(req, "site")).id, need(req, "path")),
    })),
  },
];
