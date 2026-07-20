import { z } from "zod";
import { MhError } from "../../core/errors.ts";
import {
  getServerConfig,
  normalizePublicBaseUrl,
  setServerConfig,
} from "../../core/config.ts";
import { resolveSite, updateSite, setSitePublicGrants } from "../../core/sites.ts";
import { parseGrantSet, type GrantSet } from "../../core/grants-core.ts";
import { getPeer, syncPeer } from "../../core/sync/peers.ts";
import { errorResponse, type Route, type RouteCtx } from "../../core/sync/routes.ts";

const GrantSetSchema = z.object({
  v: z.literal(1),
  tables: z.array(
    z.object({
      db: z.string(),
      ops: z.array(z.enum(["read", "create", "update"])),
    }),
  ),
});

const HostingSchema = z.object({
  publicBaseUrl: z.string().nullable(),
  scope: z.enum(["local", "lan", "public"]).nullable(),
  node: z.string(),
});

const VerifyReq = z.object({ url: z.string() });
const VerifyRes = z.object({
  ok: z.boolean(),
  url: z.string(),
  scope: z.enum(["local", "lan", "public"]),
  node: z.string(),
});
const PublishReq = z.object({
  siteId: z.string(),
  access: z.enum(["public", "private"]),
  grants: GrantSetSchema.optional(),
  targetBase: z.string().optional(),
});
const PublishRes = z.object({
  access: z.enum(["public", "private"]),
  status: z.enum(["ready", "syncing", "private"]),
  url: z.string().nullable(),
  host: z.string().nullable(),
});

async function verifyBase(
  input: string,
  expectedNode: string,
  allowRemote = true,
): Promise<{ url: string; scope: "local" | "lan" | "public"; node: string }> {
  const base = normalizePublicBaseUrl(input);
  if (!allowRemote && base.scope !== "local")
    throw new MhError(
      "invalid_input",
      "Desktop sidecar 仅用于本机预览；请启动带鉴权的 mh --server，或使用 Edge",
    );
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const res = await fetch(`${base.url}/health`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; node?: string } | null;
    if (!res.ok || !body?.ok || !body.node)
      throw new MhError("network", `站点入口健康检查失败（HTTP ${res.status}）`);
    if (body.node !== expectedNode)
      throw new MhError(
        "conflict",
        `站点入口属于另一个节点（期望 ${expectedNode}，实际 ${body.node}）`,
      );
    return { ...base, node: body.node };
  } catch (e) {
    if (e instanceof MhError) throw e;
    const message = (e as Error).name === "AbortError" ? "连接超时" : (e as Error).message;
    throw new MhError("network", `无法验证站点入口：${message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function pollSite(url: string): Promise<boolean> {
  for (let i = 0; i < 8; i++) {
    const res = await fetch(url, { method: "GET", redirect: "manual" }).catch(() => null);
    if (res && res.status >= 200 && res.status < 400) return true;
    await Bun.sleep(250);
  }
  return false;
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

export const siteHostingRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/site-hosting",
    summary: "Current node's verified public/LAN base for hosted site links.",
    response: HostingSchema,
    handler: handle((_req, { db, node }) => {
      const value = getServerConfig(db).publicBaseUrl || null;
      return {
        publicBaseUrl: value,
        scope: value ? normalizePublicBaseUrl(value).scope : null,
        node,
      };
    }),
  },
  {
    method: "PATCH",
    path: "/api/site-hosting",
    summary: "Verify and save (or clear) the current node's site hosting base.",
    request: z.object({ publicBaseUrl: z.string().nullable() }),
    response: HostingSchema,
    handler: handle(async (req, { db, node, allowRemoteSiteHosting }) => {
      const body = (await req.json()) as { publicBaseUrl: string | null };
      if (!body.publicBaseUrl) {
        const cfg = setServerConfig(db, { publicBaseUrl: null });
        return { publicBaseUrl: cfg.publicBaseUrl || null, scope: null, node };
      }
      const checked = await verifyBase(
        body.publicBaseUrl,
        node,
        allowRemoteSiteHosting ?? true,
      );
      setServerConfig(db, { publicBaseUrl: checked.url });
      return { publicBaseUrl: checked.url, scope: checked.scope, node };
    }),
  },
  {
    method: "POST",
    path: "/api/site-hosting/verify",
    summary: "Verify a reachable site-hosting base maps to the expected node.",
    request: VerifyReq,
    response: VerifyRes,
    handler: handle(async (req, { node, allowRemoteSiteHosting }) => {
      const body = VerifyReq.parse(await req.json());
      return {
        ok: true,
        ...(await verifyBase(
          body.url,
          node,
          allowRemoteSiteHosting ?? true,
        )),
      };
    }),
  },
  {
    method: "POST",
    path: "/api/site/publish",
    summary: "Publish/unpublish a site on a verified current or paired server.",
    request: PublishReq,
    response: PublishRes,
    handler: handle(async (req, { db, node, allowRemoteSiteHosting }) => {
      const body = PublishReq.parse(await req.json()) as {
        siteId: string;
        access: "public" | "private";
        grants?: GrantSet;
        targetBase?: string;
      };
      const before = resolveSite(db, body.siteId);
      if (body.access === "private") {
        updateSite(db, before.id, { visibility: "private" });
        return { access: "private", status: "private", url: null, host: null };
      }

      const peer = body.targetBase ? getPeer(db, body.targetBase) : null;
      const configured = getServerConfig(db).publicBaseUrl;
      const targetBase = body.targetBase || configured;
      if (!targetBase)
        throw new MhError(
          "invalid_input",
          "请先在“设置 → 站点托管”配置并验证当前设备的公网或局域网入口",
        );
      const expectedNode = peer?.node_id || node;
      if (!expectedNode)
        throw new MhError("conflict", "配对设备缺少节点身份，重新配对后再试");
      const checked = await verifyBase(
        targetBase,
        expectedNode,
        peer ? true : allowRemoteSiteHosting ?? true,
      );
      const previousGrants = parseGrantSet(before.public_grants);
      try {
        setSitePublicGrants(
          db,
          before.id,
          body.grants && body.grants.tables.length ? body.grants : null,
        );
        updateSite(db, before.id, { visibility: "public" });
        if (peer) {
          const sync = await syncPeer(db, peer.url);
          if (!sync.ok) throw new MhError("network", sync.error || "配对设备同步失败");
        }
        const url = `${checked.url}/sites/${encodeURIComponent(before.name)}/`;
        const ready = await pollSite(url);
        return {
          access: "public",
          status: ready ? "ready" : "syncing",
          url,
          host: checked.url,
        };
      } catch (e) {
        setSitePublicGrants(
          db,
          before.id,
          previousGrants.tables.length ? previousGrants : null,
        );
        updateSite(db, before.id, {
          visibility: before.visibility === "public" ? "public" : "private",
        });
        if (peer) await syncPeer(db, peer.url).catch(() => undefined);
        throw e;
      }
    }),
  },
];
