import { z } from "zod";
import { MhError } from "../../core/errors.ts";
import {
  getServerConfig,
  isCloudMetadataHost,
  normalizePublicBaseUrl,
  setServerConfig,
} from "../../core/config.ts";
import { resolveSite, updateSite, setSitePublicGrants } from "../../core/sites.ts";
import { parseGrantSet, type GrantSet } from "../../core/grants-core.ts";
import { getPeer, listPeers, syncPeer } from "../../core/sync/peers.ts";
import { type Route } from "../../core/sync/routes.ts";
import {
  getPendingSiteRollback,
  latestLocalSeq,
  listPendingSiteRollbacks,
  listSitePublishStates,
  putPendingSiteRollback,
  putSitePublishState,
  removePendingSiteRollback,
  removeSitePublishStates,
  updatePendingSiteRollbackError,
} from "../../core/sync/site-publish-recovery.ts";
import { jsonHandler } from "./json-handler.ts";
import {
  listSiteChannelRows,
  listSiteChannelViews,
  putSiteChannel,
  putSiteChannelObservation,
  revokePublicSiteChannels,
  setPublicSiteChannelPolicies,
  setSiteChannelDesiredState,
} from "../../core/site-channel-store.ts";
import { reconcileSiteChannelsQuietly } from "../../core/sync/site-channel-reconcile.ts";
import { requestChannelRevocation } from "../../core/site-channel-lifecycle.ts";

const GrantSetSchema = z.object({
  v: z.literal(1),
  tables: z.array(
    z.object({
      db: z.string(),
      ops: z.array(z.enum(["read", "create", "update"])),
    }),
  ),
});

const SiteChannelViewSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  audience: z.enum(["public", "link"]),
  hosting: z.enum(["device", "edge"]),
  controllerNodeId: z.string(),
  targetRef: z.string(),
  canonicalUrl: z.string().nullable(),
  policyJson: z.string().nullable(),
  desiredState: z.enum(["active", "revoked"]),
  status: z.enum([
    "provisioning",
    "syncing",
    "ready",
    "rollback_pending",
    "cleanup_pending",
    "error",
    "legacy_unverified",
    "revoked",
    "waiting_controller",
    "unverified",
  ]),
  lastVerifiedAt: z.number().nullable(),
  lastError: z.string().nullable(),
});

const HostingSchema = z.object({
  publicBaseUrl: z.string().nullable(),
  scope: z.enum(["local", "lan", "public"]).nullable(),
  node: z.string(),
  pendingRollbacks: z.array(
    z.object({
      siteId: z.string(),
      peerUrl: z.string(),
      targetUrl: z.string(),
      requiredSeq: z.number(),
      createdAt: z.number(),
      lastError: z.string(),
    }),
  ),
  publishedSites: z.array(
    z.object({
      siteId: z.string(),
      targetBase: z.string(),
      url: z.string(),
      status: z.enum(["ready", "syncing"]),
      updatedAt: z.number(),
    }),
  ),
  channels: z.array(SiteChannelViewSchema),
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
  status: z.enum([
    "ready",
    "syncing",
    "private",
    "rollback_pending",
    "cleanup_pending",
  ]),
  url: z.string().nullable(),
  host: z.string().nullable(),
  error: z.string().optional(),
});

const HEALTH_RESPONSE_MAX = 16 * 1024;
const SITE_POLL_BUDGET_MS = 10_000;
const SITE_POLL_ATTEMPT_MS = 2_000;

async function limitedJson(res: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new MhError("network", "站点入口健康响应过大");
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new MhError("network", "站点入口健康响应过大");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function verifyBase(
  input: string,
  expectedNode: string,
  allowRemote = true,
): Promise<{ url: string; scope: "local" | "lan" | "public"; node: string }> {
  const base = normalizePublicBaseUrl(input);
  const host = new URL(base.url).hostname;
  if (isCloudMetadataHost(host))
    throw new MhError("invalid_input", "站点入口不能指向云平台元数据服务");
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
      redirect: "manual",
      headers: { accept: "application/json" },
    });
    if (res.status < 200 || res.status >= 300)
      throw new MhError("network", `站点入口健康检查失败（HTTP ${res.status}）`);
    const body = (await limitedJson(res, HEALTH_RESPONSE_MAX)) as {
      ok?: boolean;
      node?: string;
      capabilities?: unknown;
    } | null;
    if (!body?.ok || !body.node)
      throw new MhError("network", "站点入口健康响应无效");
    if (body.node !== expectedNode)
      throw new MhError(
        "conflict",
        `站点入口节点不匹配（期望 ${expectedNode}，实际 ${body.node}）；这是防误配检查，不是身份认证`,
      );
    if (
      !Array.isArray(body.capabilities) ||
      !body.capabilities.includes("site_channels")
    )
      throw new MhError(
        "conflict",
        "目标设备版本不支持定向发布渠道；请先升级该设备，再重新验证入口",
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

export async function pollSite(
  url: string,
  opts: { budgetMs?: number; attemptMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + (opts.budgetMs ?? SITE_POLL_BUDGET_MS);
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(),
      Math.min(opts.attemptMs ?? SITE_POLL_ATTEMPT_MS, remaining),
    );
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: ctrl.signal,
      }).catch(() => null);
      if (res && res.status >= 200 && res.status < 300) return true;
    } finally {
      clearTimeout(timer);
    }
    const pause = Math.min(250, deadline - Date.now());
    if (pause > 0) await Bun.sleep(pause);
  }
  return false;
}

export const siteHostingRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/site-hosting",
    summary: "Current node's verified public/LAN base for hosted site links.",
    response: HostingSchema,
    handler: jsonHandler((_req, { db, node }) => {
      const value = getServerConfig(db).publicBaseUrl || null;
      return {
        publicBaseUrl: value,
        scope: value ? normalizePublicBaseUrl(value).scope : null,
        node,
        pendingRollbacks: listPendingSiteRollbacks(db),
        publishedSites: listSitePublishStates(db),
        channels: listSiteChannelViews(db),
      };
    }),
  },
  {
    method: "PATCH",
    path: "/api/site-hosting",
    summary: "Verify and save (or clear) the current node's site hosting base.",
    request: z.object({ publicBaseUrl: z.string().nullable() }),
    response: HostingSchema,
    handler: jsonHandler(async (req, { db, node, allowRemoteSiteHosting }) => {
      const body = (await req.json()) as { publicBaseUrl: string | null };
      if (!body.publicBaseUrl) {
        const cfg = setServerConfig(db, { publicBaseUrl: null });
        return {
          publicBaseUrl: cfg.publicBaseUrl || null,
          scope: null,
          node,
          pendingRollbacks: listPendingSiteRollbacks(db),
          publishedSites: listSitePublishStates(db),
          channels: listSiteChannelViews(db),
        };
      }
      const checked = await verifyBase(
        body.publicBaseUrl,
        node,
        allowRemoteSiteHosting ?? true,
      );
      setServerConfig(db, { publicBaseUrl: checked.url });
      return {
        publicBaseUrl: checked.url,
        scope: checked.scope,
        node,
        pendingRollbacks: listPendingSiteRollbacks(db),
        publishedSites: listSitePublishStates(db),
        channels: listSiteChannelViews(db),
      };
    }),
  },
  {
    method: "POST",
    path: "/api/site-hosting/verify",
    summary: "Verify a reachable site-hosting base maps to the expected node.",
    request: VerifyReq,
    response: VerifyRes,
    handler: jsonHandler(async (req, { node, allowRemoteSiteHosting }) => {
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
    handler: jsonHandler(async (req, { db, node, allowRemoteSiteHosting }) => {
      const body = PublishReq.parse(await req.json()) as {
        siteId: string;
        access: "public" | "private";
        grants?: GrantSet;
        targetBase?: string;
      };
      const before = resolveSite(db, body.siteId);
      if (body.access === "private") {
        const channels = listSiteChannelRows(db, before.id).filter(
          (channel) =>
            channel.audience === "public" &&
            channel.desired_state === "active",
        );
        revokePublicSiteChannels(db, before.id);
        const remoteTargets = [
          ...new Set(
            channels
              .filter(
                (channel) =>
                  channel.hosting === "device" &&
                  channel.target_ref !== node,
              )
              .map((channel) => channel.target_ref),
          ),
        ];
        const results = new Map<
          string,
          { ok: boolean; error?: string }
        >();
        await Promise.all(
          remoteTargets.map(async (targetNode) => {
            const peer = listPeers(db).find(
              (candidate) =>
                candidate.kind === "http" &&
                candidate.enabled === 1 &&
                candidate.node_id === targetNode,
            );
            if (!peer) {
              results.set(targetNode, {
                ok: false,
                error: "没有可直连的托管设备，等待后续同步",
              });
              return;
            }
            const result = await syncPeer(db, peer.url, {
              timeoutMs: 10_000,
            });
            results.set(targetNode, {
              ok: result.ok,
              ...(result.error ? { error: result.error } : {}),
            });
          }),
        );
        for (const channel of channels) {
          const remoteResult = results.get(channel.target_ref);
          putSiteChannelObservation(db, {
            channelId: channel.id,
            status:
              channel.hosting === "device" &&
              channel.target_ref === node
                ? "revoked"
                : remoteResult?.ok
                  ? "revoked"
                  : "cleanup_pending",
            lastVerifiedAt:
              (
                channel.hosting === "device" &&
                channel.target_ref === node
              ) ||
              remoteResult?.ok
                ? Date.now()
                : null,
            lastError:
              (
                channel.hosting === "device" &&
                channel.target_ref === node
              ) ||
              remoteResult?.ok
                ? null
                : remoteResult?.error ??
                  "等待控制设备同步撤销状态",
          });
        }
        updateSite(db, before.id, { visibility: "private" });
        removeSitePublishStates(db, before.id);
        const pending = channels.filter(
          (channel) =>
            !(
              channel.hosting === "device" &&
              (
                channel.target_ref === node ||
                results.get(channel.target_ref)?.ok
              )
            ),
        );
        return {
          access: "private",
          status:
            pending.length > 0 ? "cleanup_pending" : "private",
          url: null,
          host: null,
          ...(pending.length > 0
            ? {
                error: pending
                  .map(
                    (channel) =>
                      results.get(channel.target_ref)?.error ??
                      "等待控制设备同步撤销状态",
                  )
                  .filter(Boolean)
                  .join("；"),
              }
            : {}),
        };
      }

      const peer = body.targetBase ? getPeer(db, body.targetBase) : null;
      const configured = getServerConfig(db).publicBaseUrl;
      const targetBase = body.targetBase || configured;
      if (!targetBase)
        throw new MhError(
          "invalid_input",
          "请先在“设置 → 站点托管”配置并验证当前设备的公网或局域网入口",
        );
      if (peer && !peer.node_id)
        throw new MhError("conflict", "配对设备缺少节点身份，重新配对后再试");
      const expectedNode = peer ? peer.node_id! : node;
      if (peer && getPendingSiteRollback(db, before.id, peer.url))
        throw new MhError("conflict", "该站点仍在等待目标设备确认回滚，请先重试回滚");
      const checked = await verifyBase(
        targetBase,
        expectedNode,
        peer ? true : allowRemoteSiteHosting ?? true,
      );
      const url = `${checked.url}/sites/${encodeURIComponent(before.name)}/`;
      const previousChannel = listSiteChannelRows(db, before.id).find(
        (channel) =>
          channel.audience === "public" &&
          channel.hosting === "device" &&
          channel.target_ref === expectedNode,
      );
      let channelId: string | null = null;
      const previousGrants = parseGrantSet(before.public_grants);
      try {
        const channel = putSiteChannel(db, {
          siteId: before.id,
          audience: "public",
          hosting: "device",
          // For a device channel the host applies synced revocation, so it is
          // also the controller even when another node initiated publishing.
          controllerNodeId: expectedNode,
          targetRef: expectedNode,
          canonicalUrl: url,
          policy: body.grants ?? { v: 1, tables: [] },
        });
        channelId = channel.id;
        putSiteChannelObservation(db, {
          channelId,
          status: "provisioning",
        });
        setSitePublicGrants(
          db,
          before.id,
          body.grants && body.grants.tables.length ? body.grants : null,
        );
        setPublicSiteChannelPolicies(
          db,
          before.id,
          body.grants ?? { v: 1, tables: [] },
        );
        // Channel rows are the access authority. Keep the legacy global
        // visibility register private so a mixed-version peer cannot ignore
        // the target node and accidentally serve this site too.
        updateSite(db, before.id, { visibility: "private" });
        if (peer) {
          const sync = await syncPeer(db, peer.url, { timeoutMs: 10_000 });
          if (!sync.ok) throw new MhError("network", sync.error || "配对设备同步失败");
        }
        const ready = await pollSite(url);
        putSitePublishState(db, {
          siteId: before.id,
          targetBase: peer?.url ?? checked.url,
          url,
          status: ready ? "ready" : "syncing",
          updatedAt: Date.now(),
        });
        putSiteChannelObservation(db, {
          channelId,
          status: ready ? "ready" : "syncing",
          lastVerifiedAt: ready ? Date.now() : null,
        });
        return {
          access: "public",
          status: ready ? "ready" : "syncing",
          url,
          host: checked.url,
        };
      } catch (e) {
        if (channelId) {
          if (previousChannel) {
            let previousPolicy: unknown = null;
            try {
              previousPolicy =
                previousChannel.policy_json == null
                  ? null
                  : JSON.parse(previousChannel.policy_json);
            } catch {
              // Invalid synced policy stays default-deny during rollback.
            }
            putSiteChannel(db, {
              id: previousChannel.id,
              siteId: previousChannel.site_id,
              audience: "public",
              hosting: "device",
              controllerNodeId: previousChannel.controller_node_id,
              targetRef: previousChannel.target_ref,
              canonicalUrl: previousChannel.canonical_url,
              policy: previousPolicy,
              desiredState:
                previousChannel.desired_state === "active"
                  ? "active"
                  : "revoked",
            });
          } else {
            setSiteChannelDesiredState(db, channelId, "revoked");
          }
          putSiteChannelObservation(db, {
            channelId,
            status: peer ? "rollback_pending" : "error",
            lastError: (e as Error).message || "发布失败",
          });
        }
        setSitePublicGrants(
          db,
          before.id,
          previousGrants.tables.length ? previousGrants : null,
        );
        setPublicSiteChannelPolicies(db, before.id, previousGrants);
        updateSite(db, before.id, {
          visibility: before.visibility === "public" ? "public" : "private",
        });
        if (peer) {
          const requiredSeq = latestLocalSeq(db);
          const rollback = await syncPeer(db, peer.url, { timeoutMs: 10_000 });
          if (!rollback.ok) {
            const error = rollback.error || (e as Error).message || "远端回滚尚未确认";
            putPendingSiteRollback(db, {
              siteId: before.id,
              peerUrl: peer.url,
              targetUrl: `${checked.url}/sites/${encodeURIComponent(before.name)}/`,
              requiredSeq,
              createdAt: Date.now(),
              lastError: error,
            });
            return {
              access: "private",
              status: "rollback_pending",
              url: null,
              host: checked.url,
              error,
            };
          }
        }
        throw e;
      }
    }),
  },
  {
    method: "POST",
    path: "/api/site/publish/recover",
    summary: "Retry a paired-device rollback that has not yet been acknowledged.",
    request: z.object({ siteId: z.string(), targetBase: z.string() }),
    response: PublishRes,
    handler: jsonHandler(async (req, { db }) => {
      const body = (await req.json()) as { siteId: string; targetBase: string };
      const pending = getPendingSiteRollback(db, body.siteId, body.targetBase);
      if (!pending) throw new MhError("not_found", "没有待确认的站点回滚");
      const peer = getPeer(db, pending.peerUrl);
      if (!peer) throw new MhError("not_found", "目标配对设备不存在，请重新配对后重试");
      const out = await syncPeer(db, peer.url, { timeoutMs: 10_000 });
      if (!out.ok) {
        const error = out.error || "远端回滚尚未确认";
        updatePendingSiteRollbackError(db, pending.siteId, pending.peerUrl, error);
        return {
          access: "private",
          status: "rollback_pending",
          url: null,
          host: new URL(pending.targetUrl).origin,
          error,
        };
      }
      removePendingSiteRollback(db, pending.siteId, pending.peerUrl);
      return {
        access: "private",
        status: "private",
        url: null,
        host: new URL(pending.targetUrl).origin,
      };
    }),
  },
  {
    method: "PATCH",
    path: "/api/site/channel",
    summary:
      "Change a synced site channel's desired state; controller applies node-local cleanup when online.",
    request: z.object({
      id: z.string(),
      desiredState: z.literal("revoked"),
    }),
    response: SiteChannelViewSchema,
    handler: jsonHandler(async (req, { db }) => {
      const body = z
        .object({ id: z.string(), desiredState: z.literal("revoked") })
        .parse(await req.json());
      const { channel, needsReconcile } = requestChannelRevocation(db, body.id);
      if (needsReconcile) await reconcileSiteChannelsQuietly(db);
      const view = listSiteChannelViews(db).find(
        (item) => item.id === channel.id,
      );
      if (!view) throw new MhError("not_found", "站点渠道已不存在");
      return view;
    }),
  },
];
