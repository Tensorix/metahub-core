import { z } from "zod";
import { MhError } from "../errors.ts";
import { errorResponse, type Route, type RouteCtx } from "./routes.ts";
import {
  listSites,
  listFiles,
  fileSizeOf,
  fileCounts,
  resolveSite,
  createSite,
  setSitePublicGrants,
  putFile,
  deleteFile,
} from "../sites.ts";
import { parseGrantSet, type GrantSet } from "../grants-core.ts";
import {
  applySiteDelete,
  applySiteUpdate,
  putSiteChannel,
  putSiteChannelObservation,
  setPublicSiteChannelPolicies,
} from "../site-channel-store.ts";
import { reconcileSiteChannelsQuietly } from "./site-channel-reconcile.ts";
import { getServerConfig } from "../config.ts";
import { getNodeId } from "../node.ts";
import type { SiteRow } from "../sites-core.ts";

// Site endpoints for the WebUI / served pages. Reads (list sites/files) and
// authoring (create, rename, delete, upload) both wrap the same core functions
// the `mh site` CLI uses, so changes ride the CRDT oplog and replicate over
// /sync. All routes are gated by the server's master-token middleware.

const SiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  created_hlc: z.string(),
  // Raw register value — readers must apply isSitePublic's default-deny
  // (only exactly "public" is public; a peer can sync arbitrary strings).
  visibility: z.string().nullable(),
  spa: z.number(),
  // Raw serialized GrantSet register — readers must go through parseGrantSet.
  public_grants: z.string().nullable(),
});
// Anonymous data grants (table × ops) for a public site's /sites/<name>/api/*.
const GrantSetSchema = z.object({
  v: z.literal(1),
  tables: z.array(
    z.object({
      db: z.string().describe("database id (never a name)"),
      ops: z.array(z.enum(["read", "create", "update"])),
    }),
  ),
});
const SiteGrantsRes = z.object({ grants: GrantSetSchema });
const SiteWithCountSchema = SiteSchema.extend({ file_count: z.number() });
const SiteFileSchema = z.object({
  id: z.string(),
  site_id: z.string(),
  path: z.string(),
  content_type: z.string(),
  encoding: z.string(),
  // Derived served-byte size (see core listFiles); null when a blob's bytes
  // aren't held locally.
  size: z.number().nullable(),
});
// Request bodies — used both for the OpenAPI doc and to .parse() at runtime so a
// malformed body is a clean 400 rather than an `as`-cast lie. Semantic rules
// (slug/path shape) live in core (normalizeSiteName/normalizeSitePath).
const CreateSiteBody = z.object({
  name: z.string(),
  title: z.string().optional(),
  visibility: z.enum(["public", "private"]).optional(),
});
const UpdateSiteBody = z.object({
  name: z.string().optional(),
  title: z.string().optional(),
  visibility: z.enum(["public", "private"]).optional(),
  spa: z.boolean().optional(),
});

function need(req: Request, key: string): string {
  const v = new URL(req.url).searchParams.get(key);
  if (!v) throw new MhError("invalid_input", `missing query param: ${key}`);
  return v;
}

function handle(fn: (req: Request, ctx: RouteCtx) => unknown): Route["handler"] {
  return async (req, ctx) => {
    try {
      return Response.json((await fn(req, ctx)) ?? null);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

function recordPublicChannel(
  req: Request,
  db: RouteCtx["db"],
  site: SiteRow,
): void {
  const node = getNodeId(db);
  const base = getServerConfig(db).publicBaseUrl ?? new URL(req.url).origin;
  const channel = putSiteChannel(db, {
    siteId: site.id,
    audience: "public",
    hosting: "device",
    targetRef: node,
    canonicalUrl: `${base}/sites/${encodeURIComponent(site.name)}/`,
    policy: parseGrantSet(site.public_grants),
  });
  putSiteChannelObservation(db, {
    channelId: channel.id,
    status: "legacy_unverified",
  });
}

export const sitesRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/sites",
    summary: "List published sites (with file counts)",
    response: z.array(SiteWithCountSchema),
    handler: handle((_req, { db }) => {
      const counts = fileCounts(db); // one GROUP BY instead of a per-site N+1
      return listSites(db).map((s) => ({ ...s, file_count: counts.get(s.id) ?? 0 }));
    }),
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
      const site = createSite(db, {
        ...body,
        // Public access is scoped by the explicit channel below. Never emit
        // the legacy global-public register for a new publication.
        visibility:
          body.visibility === "public" ? "private" : body.visibility,
      });
      if (body.visibility === "public") recordPublicChannel(req, db, site);
      return site;
    }),
  },
  {
    method: "PATCH",
    path: "/api/site",
    summary: "Rename a site, change its title, or set visibility/SPA mode. Query: ?id=<id>",
    request: UpdateSiteBody,
    response: SiteSchema,
    handler: handle(async (req, { db }) => {
      const body = UpdateSiteBody.parse(await req.json());
      return applySiteUpdate(db, need(req, "id"), body, {
        recordPublic: (site) => recordPublicChannel(req, db, site),
      });
    }),
  },
  {
    method: "DELETE",
    path: "/api/site",
    summary: "Delete a site and its files. Query: ?id=<id>",
    response: z.object({ ok: z.boolean() }),
    handler: handle(async (req, { db }) => {
      const ok = applySiteDelete(db, need(req, "id"));
      // The delete is committed; failing local channel cleanup must not turn
      // the response into a 500 (it retries on every future sync).
      await reconcileSiteChannelsQuietly(db);
      return { ok };
    }),
  },
  {
    method: "GET",
    path: "/api/site/grants",
    summary:
      "A site's public data grants (anonymous /sites/<name>/api/* access), parsed default-deny. Query: ?id=<id>",
    response: SiteGrantsRes,
    handler: handle((req, { db }) => ({
      grants: parseGrantSet(resolveSite(db, need(req, "id")).public_grants),
    })),
  },
  {
    method: "PUT",
    path: "/api/site/grants",
    summary:
      "Replace a site's public data grants. Body is a GrantSet ({v:1,tables:[{db,ops}]}); an empty tables array clears them. Effective while an explicit public channel is active (or on an unmigrated legacy-public site). Query: ?id=<id>",
    request: GrantSetSchema,
    response: SiteGrantsRes,
    handler: handle(async (req, { db }) => {
      const body = GrantSetSchema.parse(await req.json()) as GrantSet;
      const site = resolveSite(db, need(req, "id"));
      const updated = setSitePublicGrants(db, site.id, body.tables.length ? body : null);
      setPublicSiteChannelPolicies(db, site.id, parseGrantSet(updated.public_grants));
      return { grants: parseGrantSet(updated.public_grants) };
    }),
  },
  {
    method: "POST",
    path: "/api/site/file",
    summary: "Upload/replace a file. Query: ?site=<id|name>&path=<path>; body is raw bytes",
    // `changed: false` = skip-unchanged no-op (identical bytes already live).
    response: SiteFileSchema.extend({ changed: z.boolean() }),
    handler: handle(async (req, { db }) => {
      const site = resolveSite(db, need(req, "site"));
      // Fall back to path-based inference when the browser sends no/generic type.
      const ct = req.headers.get("content-type");
      const file = await putFile(db, site.id, need(req, "path"), {
        data: await req.arrayBuffer(),
        contentType: ct && ct !== "application/octet-stream" ? ct : undefined,
      });
      const { content: _content, ...summary } = file;
      return { ...summary, size: fileSizeOf(db, file) };
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
