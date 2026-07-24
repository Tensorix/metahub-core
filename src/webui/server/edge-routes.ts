import { z } from "zod";
import { MhError } from "../../core/errors.ts";
import { type Route } from "../../core/sync/routes.ts";
import {
  connectEdge,
  deployEdge,
  disconnectEdge,
  edgeStatus,
  provisionR2Bucket,
  type EdgeDeployInput,
} from "../../core/sync/edge-service.ts";
import {
  cfOAuthConfigured,
  discoverAccounts,
  startCfLogin,
  type CfAccount,
  type CfLoginHandle,
} from "../../core/sync/cf-oauth.ts";
import { randomSuffix } from "../../core/ids.ts";
import { getEdgeWorkerScript } from "../../cli/edge-worker-script.ts";
import { jsonHandler } from "./json-handler.ts";

// In-flight "Sign in with Cloudflare" flows. The loopback catcher and the
// resulting access token live ONLY here on the server — the browser opens the
// consent URL and polls for the discovered account list, then triggers the
// deploy by flowId. The token is never sent to the browser and is discarded
// once the deploy that consumes it returns.
interface CfFlow {
  handle: CfLoginHandle;
  state: "pending" | "ready" | "error";
  token?: string;
  accounts?: CfAccount[];
  error?: string;
  createdAt: number;
}
const flows = new Map<string, CfFlow>();
const FLOW_TTL_MS = 10 * 60_000;

function pruneFlows(now: number): void {
  for (const [id, f] of flows)
    if (now - f.createdAt > FLOW_TTL_MS) {
      f.handle.cancel();
      flows.delete(id);
    }
}

const EdgeStatusSchema = z.any();
const EdgeDeploySchema = z.object({
  // OAuth path: reference an OAuth flow that already holds the access token.
  flowId: z.string().optional(),
  accountId: z.string().optional(),
  // Fallback path (headless/CI): a pasted API token.
  apiToken: z.string().optional(),
  workerName: z.string().optional(),
  d1Name: z.string().optional(),
  workersSubdomain: z.string().optional(),
  confirmed: z.boolean(),
  /** Keep the OAuth flow's token alive for a follow-up call (the one-stop modal
   *  sequences deploy → R2 provision on a single sign-in). */
  keepFlow: z.boolean().optional(),
});
const EdgeR2Schema = z.object({
  flowId: z.string().optional(),
  accountId: z.string().optional(),
  apiToken: z.string().optional(),
  bucketName: z.string().optional(),
  confirmed: z.boolean(),
  keepFlow: z.boolean().optional(),
});
const EdgeConnectSchema = z.object({ endpoint: z.string(), token: z.string() });

/** Resolve credentials from a flowId (OAuth) or a pasted apiToken; the caller
 *  discards the flow after use unless keepFlow was set. */
function resolveCfCreds(body: {
  flowId?: string;
  accountId?: string;
  apiToken?: string;
}): { accountId?: string; apiToken?: string; consumeFlow?: string } {
  let { accountId, apiToken } = body;
  let consumeFlow: string | undefined;
  if (body.flowId) {
    const flow = flows.get(body.flowId);
    if (!flow) throw new MhError("not_found", "OAuth 流程不存在或已过期，请重新登录");
    if (flow.state === "error") throw new MhError("auth", flow.error || "Cloudflare 授权失败");
    if (flow.state !== "ready" || !flow.token)
      throw new MhError("conflict", "Cloudflare 授权尚未完成，请稍候");
    apiToken = flow.token;
    // Single account → auto-select; multiple → the caller must have chosen one.
    accountId = accountId || (flow.accounts?.length === 1 ? flow.accounts[0]!.id : undefined);
    consumeFlow = body.flowId;
  }
  return { accountId, apiToken, consumeFlow };
}

function dropFlow(flowId: string | undefined): void {
  if (!flowId) return;
  flows.get(flowId)?.handle.cancel();
  flows.delete(flowId);
}

export const edgeRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/edge",
    summary: "Edge endpoint health, version, deployment progress and rooms.",
    response: EdgeStatusSchema,
    handler: jsonHandler(async (_req, { db }) => ({
      ...(await edgeStatus(db)),
      oauthConfigured: cfOAuthConfigured(),
    })),
  },
  {
    method: "POST",
    path: "/api/edge/oauth/begin",
    summary: "Start a Sign-in-with-Cloudflare flow; returns the consent URL + flow id.",
    response: z.object({ flowId: z.string(), authUrl: z.string() }),
    handler: jsonHandler(async () => {
      pruneFlows(Date.now());
      const handle = await startCfLogin();
      const flowId = randomSuffix(24);
      const flow: CfFlow = { handle, state: "pending", createdAt: Date.now() };
      flows.set(flowId, flow);
      // Await the redirect + exchange in the background; discover accounts so the
      // browser can pick one without ever seeing the token.
      handle
        .waitForToken()
        .then(async (t) => {
          flow.token = t.accessToken;
          flow.accounts = await discoverAccounts(t.accessToken);
          flow.state = "ready";
        })
        .catch((e) => {
          flow.state = "error";
          flow.error = (e as Error).message;
        });
      return { flowId, authUrl: handle.authUrl };
    }),
  },
  {
    method: "GET",
    path: "/api/edge/oauth/status",
    summary: "Poll a Sign-in-with-Cloudflare flow; returns state + discovered accounts (never the token).",
    response: z.object({
      state: z.enum(["pending", "ready", "error"]),
      accounts: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
      error: z.string().optional(),
    }),
    handler: jsonHandler((req) => {
      const flowId = new URL(req.url).searchParams.get("flowId") ?? "";
      const flow = flows.get(flowId);
      if (!flow) throw new MhError("not_found", "OAuth 流程不存在或已过期，请重试");
      return { state: flow.state, accounts: flow.accounts, error: flow.error };
    }),
  },
  {
    method: "DELETE",
    path: "/api/edge/oauth",
    summary: "Cancel a Sign-in-with-Cloudflare flow (modal closed) and tear down its listener.",
    response: z.object({ ok: z.boolean() }),
    handler: jsonHandler((req) => {
      const flowId = new URL(req.url).searchParams.get("flowId") ?? "";
      const flow = flows.get(flowId);
      if (flow) {
        flow.handle.cancel();
        flows.delete(flowId);
      }
      return { ok: true };
    }),
  },
  {
    method: "POST",
    path: "/api/edge/deploy",
    summary: "Create/upgrade a dedicated Cloudflare Worker and D1 after explicit confirmation.",
    request: EdgeDeploySchema,
    response: z.any(),
    handler: jsonHandler(async (req, { db }) => {
      const body = EdgeDeploySchema.parse(await req.json());
      const { accountId, apiToken, consumeFlow } = resolveCfCreds(body);
      if (!accountId) throw new MhError("invalid_input", "缺少 Cloudflare 账号 id");
      if (!apiToken) throw new MhError("invalid_input", "缺少 Cloudflare 凭据（请先登录或提供 API Token）");
      const input: EdgeDeployInput = {
        accountId,
        apiToken,
        workerName: body.workerName,
        d1Name: body.d1Name,
        workersSubdomain: body.workersSubdomain,
        confirmed: body.confirmed,
      };
      try {
        return await deployEdge(db, input, await getEdgeWorkerScript());
      } finally {
        // Discard the OAuth token immediately after use — never persisted.
        // keepFlow lets the one-stop modal run the R2 step on the same sign-in
        // (the flow still dies with its TTL if the follow-up never comes).
        if (!body.keepFlow) dropFlow(consumeFlow);
      }
    }),
  },
  {
    method: "POST",
    path: "/api/edge/r2",
    summary: "Create an R2 sync bucket after explicit confirmation (credentials stay a dashboard step).",
    request: EdgeR2Schema,
    response: z.any(),
    handler: jsonHandler(async (req, { db }) => {
      const body = EdgeR2Schema.parse(await req.json());
      const { accountId, apiToken, consumeFlow } = resolveCfCreds(body);
      if (!accountId) throw new MhError("invalid_input", "缺少 Cloudflare 账号 id");
      if (!apiToken) throw new MhError("invalid_input", "缺少 Cloudflare 凭据（请先登录或提供 API Token）");
      try {
        return await provisionR2Bucket(db, {
          accountId,
          apiToken,
          bucketName: body.bucketName,
          confirmed: body.confirmed,
        });
      } finally {
        if (!body.keepFlow) dropFlow(consumeFlow);
      }
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
