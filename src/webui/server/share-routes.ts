import { z } from "zod";
import { errorResponse, type Route } from "../../core/sync/routes.ts";
import { MhError } from "../../core/errors.ts";
import { getPeer } from "../../core/sync/peers.ts";
import {
  createShareAction,
  revokeShareAction,
  renewShareAction,
  listSharesAggregated,
  listSharesLocal,
  listShareServers,
  listShareBuckets,
  type CreateShareRequest,
} from "../../core/sync/share-actions.ts";

// Share management. POST/DELETE /api/share and GET /api/shares additionally accept
// a pairing grant (see server.ts gate) so a paired peer can create/list/revoke a
// share on this node remotely. The PUBLIC surface — opening a share — is the
// separate token-exempt /share/<slug> path (core/sync/share-serve.ts).

const CreateShareReq = z.object({
  kind: z.enum(["doc", "database", "site"]),
  ref: z.string(),
  transport: z.enum(["server", "s3"]).optional(),
  hosting: z.enum(["server", "room"]).optional(),
  permission: z.enum(["view", "edit"]).optional(),
  password: z.string().nullable().optional(),
  expiresMs: z.number().nullable().optional(),
  server: z.string().nullable().optional(),
  bucketUrl: z.string().nullable().optional(),
  viewerBase: z.string().optional(),
  // Serialized GrantSet enabling /share/<slug>/api/* (server transport only).
  grants: z.string().nullable().optional(),
});
const CreatedShareRes = z.object({
  slug: z.string(),
  kind: z.string(),
  permission: z.string(),
  transport: z.string(),
  hosting: z.string(),
  url: z.string(),
  expiresAt: z.number().nullable(),
  source: z.string(),
});
const ShareListItemRes = z.object({
  slug: z.string(),
  kind: z.string(),
  target_id: z.string(),
  title: z.string(),
  permission: z.string(),
  transport: z.string(),
  source: z.string(),
  sourceKind: z.string(),
  sourceUrl: z.string().optional(),
  hosting: z.string().optional(),
  expiresAt: z.number().nullable(),
  hasPassword: z.boolean(),
  url: z.string().optional(),
});

function originBase(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

export const shareRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/share/servers",
    summary: "Paired servers a share can be created on / served by (master-only).",
    response: z.array(
      z.object({
        url: z.string(),
        label: z.string(),
        enabled: z.boolean(),
        lastStatus: z.string().nullable(),
        lastSuccessAt: z.number().nullable(),
      }),
    ),
    handler: (_req, { db }) => Response.json(listShareServers(db)),
  },
  {
    method: "GET",
    path: "/api/share/buckets",
    summary: "Object-storage buckets available as a share transport (master-only).",
    response: z.array(z.object({ url: z.string(), label: z.string() })),
    handler: (_req, { db }) => Response.json(listShareBuckets(db)),
  },
  {
    method: "GET",
    path: "/api/shares",
    summary:
      "List shares this node serves (its local server shares + its buckets). Query: ?target=<id>. " +
      "Accepts a pairing grant so a peer's aggregated list can fan in. Does NOT fan out itself.",
    response: z.array(ShareListItemRes),
    handler: async (req, { db }) => {
      try {
        const target = new URL(req.url).searchParams.get("target") ?? undefined;
        return Response.json(await listSharesLocal(db, target));
      } catch (e) {
        return errorResponse(e);
      }
    },
  },
  {
    method: "GET",
    path: "/api/shares/all",
    summary: "Master-only aggregated share list across this node, paired devices, and buckets.",
    response: z.array(ShareListItemRes),
    handler: async (req, { db }) => {
      try {
        const target = new URL(req.url).searchParams.get("target") ?? undefined;
        return Response.json(await listSharesAggregated(db, target));
      } catch (e) {
        return errorResponse(e);
      }
    },
  },
  {
    method: "POST",
    path: "/api/share",
    summary: "Create a share (transport: server | s3). server=<peer url> creates it remotely on that peer.",
    request: CreateShareReq,
    response: CreatedShareRes,
    handler: async (req, { db }) => {
      try {
        const body = (await req.json()) as Partial<CreateShareRequest>;
        if (!body.kind || !body.ref) throw new MhError("invalid_input", "kind and ref are required");
        const transport = body.transport ?? "server";
        // For a LOCAL server share, default the recorded base to the address the
        // caller reached us on (so the copied link is reachable). A peer url in
        // `server` is left as-is → createShareAction creates it on that peer.
        let server = body.server ?? undefined;
        if (transport === "server" && !isPeer(db, server)) server = server || originBase(req);
        const out = await createShareAction(db, {
          kind: body.kind,
          ref: body.ref,
          transport,
          hosting: body.hosting,
          permission: body.permission,
          password: body.password ?? null,
          expiresMs: body.expiresMs ?? null,
          server,
          bucketUrl: body.bucketUrl ?? null,
          viewerBase: body.viewerBase,
          grants: body.grants ?? null,
        });
        return Response.json(out);
      } catch (e) {
        return errorResponse(e);
      }
    },
  },
  {
    method: "POST",
    path: "/api/share/renew",
    summary: "Re-presign an object-storage share and return a fresh link. Query: ?slug=<slug>",
    response: CreatedShareRes,
    handler: async (req, { db }) => {
      try {
        const slug = new URL(req.url).searchParams.get("slug");
        if (!slug) throw new MhError("invalid_input", "slug required");
        return Response.json(await renewShareAction(db, slug));
      } catch (e) {
        return errorResponse(e);
      }
    },
  },
  {
    method: "DELETE",
    path: "/api/share",
    summary: "Revoke a share (local server row, or a bucket share's objects). Query: ?slug=<slug>",
    response: z.object({ ok: z.boolean() }),
    handler: async (req, { db }) => {
      try {
        const slug = new URL(req.url).searchParams.get("slug");
        if (!slug) throw new MhError("invalid_input", "slug required");
        return Response.json({ ok: await revokeShareAction(db, slug) });
      } catch (e) {
        return errorResponse(e);
      }
    },
  },
  {
    method: "DELETE",
    path: "/api/share/managed",
    summary: "Master-only revoke routed to the local node or the paired device that owns it.",
    response: z.object({ ok: z.boolean() }),
    handler: async (req, { db }) => {
      try {
        const url = new URL(req.url);
        const slug = url.searchParams.get("slug");
        const via = url.searchParams.get("via");
        if (!slug) throw new MhError("invalid_input", "slug required");
        if (!via) return Response.json({ ok: await revokeShareAction(db, slug) });
        const peer = listShareServers(db).find((item) => item.url === via);
        const token = peer ? getPeer(db, via)?.token : null;
        if (!peer || !token) throw new MhError("not_found", "paired share owner not found");
        const res = await fetch(
          `${via.replace(/\/+$/, "")}/api/share?slug=${encodeURIComponent(slug)}`,
          { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
        ).catch((e) => {
          throw new MhError("network", `could not reach ${via}: ${(e as Error).message}`);
        });
        const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok) throw new MhError("network", body?.error || `remote revoke failed: ${res.status}`);
        return Response.json({ ok: !!body?.ok });
      } catch (e) {
        return errorResponse(e);
      }
    },
  },
];

function isPeer(db: import("../../core/driver.ts").DbDriver, url?: string): boolean {
  if (!url) return false;
  return listShareServers(db).some((s) => s.url === url);
}
