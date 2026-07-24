// Thin Cloudflare REST wrapper for the Edge deployment pipeline. Calls that
// create account resources are only reached after an explicit WebUI/CLI deploy
// confirmation. Deployment uses the declarative `exports` metadata field
// (spike ⑥): the exports map is the source of truth and re-submitting the same
// map is naturally idempotent — no migration tag bookkeeping. The map carries
// the MhRoom Durable Object class (share rooms, Stage C).
//
// Honesty note surfaced by the CLI: Cloudflare API tokens scope to the ACCOUNT
// (Workers Scripts Edit has no per-script granularity), so "only touches the
// named resources" is a behavioral promise auditable in this source, not a
// token-enforced one.

import { MhError } from "../errors.ts";
import type { CfApiTarget } from "./edge-config.ts";

const CF_API = "https://api.cloudflare.com/client/v4";

interface CfResult<T> {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

async function cfCall<T>(
  cfg: Pick<CfApiTarget, "accountId" | "apiToken">,
  method: string,
  path: string,
  init: { body?: string | FormData; headers?: Record<string, string> } = {},
): Promise<{ status: number; data: CfResult<T> | null }> {
  let res: Response;
  try {
    res = await fetch(`${CF_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.apiToken}`, ...init.headers },
      body: init.body,
    });
  } catch (e) {
    throw new MhError("network", `Cloudflare API unreachable: ${(e as Error).message}`);
  }
  const data = (await res.json().catch(() => null)) as CfResult<T> | null;
  return { status: res.status, data };
}

function cfError(status: number, data: CfResult<unknown> | null, what: string): MhError {
  const detail = data?.errors?.map((e) => e.message).filter(Boolean).join("; ") || `HTTP ${status}`;
  if (status === 401 || status === 403)
    return new MhError("auth", `Cloudflare rejected the API token (${what}): ${detail}`);
  return new MhError("network", `Cloudflare API failed (${what}): ${detail}`);
}

/** Does the named Worker script exist? Used to prevent adopting or overwriting
 *  a same-name script that this deployment did not create. */
export async function workerDeployment(
  cfg: CfApiTarget,
): Promise<{ exists: boolean; deploymentId: string | null }> {
  const { status, data } = await cfCall<{
    bindings?: { name?: string; type?: string; text?: string }[];
  }>(
    cfg,
    "GET",
    `/accounts/${cfg.accountId}/workers/scripts/${cfg.workerName}/settings`,
  );
  if (status === 404) return { exists: false, deploymentId: null };
  if (!data?.success) throw cfError(status, data, "worker lookup");
  const marker = data.result?.bindings?.find(
    (x) => x.name === "MH_DEPLOYMENT_ID" && x.type === "plain_text",
  );
  return { exists: true, deploymentId: marker?.text ?? null };
}

export async function workerExists(cfg: CfApiTarget): Promise<boolean> {
  return (await workerDeployment(cfg)).exists;
}

/** Does the named D1 database exist? */
export async function d1Exists(cfg: CfApiTarget): Promise<boolean> {
  const { status, data } = await cfCall(cfg, "GET", `/accounts/${cfg.accountId}/d1/database/${cfg.d1Id}`);
  if (status === 404) return false;
  if (!data?.success) throw cfError(status, data, "d1 lookup");
  return true;
}

export interface D1DatabaseSummary {
  id: string;
  name: string;
  createdAt: string | null;
}

/** Exact-name lookup used only by the crash-resume path. D1's API accepts a
 * name filter but we still filter the result exactly before adopting it. */
export async function d1DatabasesByName(
  cfg: Pick<CfApiTarget, "accountId" | "apiToken">,
  name: string,
): Promise<D1DatabaseSummary[]> {
  const { status, data } = await cfCall<
    { uuid?: string; id?: string; name?: string; created_at?: string }[]
  >(
    cfg,
    "GET",
    `/accounts/${cfg.accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=10`,
  );
  if (!data?.success) throw cfError(status, data, "d1 lookup by name");
  return (data.result ?? [])
    .filter((x) => x.name === name && !!(x.uuid ?? x.id))
    .map((x) => ({
      id: (x.uuid ?? x.id)!,
      name: x.name!,
      createdAt: x.created_at ?? null,
    }));
}

// ---- R2 (sync-bucket provisioning; the "connect Cloudflare" one-stop) ----------
// OAuth CAN create/inspect buckets (workers-r2.write) but structurally CANNOT
// mint R2 S3 credentials (API-token creation has no OAuth scope) — the flow
// creates the bucket, then walks the user to "Manage R2 API Tokens" to paste
// the S3 keys (C0 spike verdict, task #1).

/** Does the named R2 bucket exist? */
export async function r2BucketExists(
  cfg: Pick<CfApiTarget, "accountId" | "apiToken">,
  name: string,
): Promise<boolean> {
  const { status, data } = await cfCall(
    cfg,
    "GET",
    `/accounts/${cfg.accountId}/r2/buckets/${encodeURIComponent(name)}`,
  );
  if (status === 404) return false;
  if (!data?.success) throw cfError(status, data, "r2 bucket lookup");
  return true;
}

/** Create the named R2 bucket. Mirrors createD1Database's stance: a same-name
 *  bucket that already exists is refused, never silently adopted (mh only
 *  touches resources this flow itself named and created; the resume path in
 *  edge-service tolerates its OWN half-finished creation via the persisted
 *  progress record, not here). */
export async function createR2Bucket(
  cfg: Pick<CfApiTarget, "accountId" | "apiToken">,
  name: string,
): Promise<void> {
  if (await r2BucketExists(cfg, name))
    throw new MhError(
      "conflict",
      `an R2 bucket named '${name}' already exists — pick another name, or attach the existing bucket manually`,
    );
  const { status, data } = await cfCall(cfg, "POST", `/accounts/${cfg.accountId}/r2/buckets`, {
    body: JSON.stringify({ name }),
    headers: { "content-type": "application/json" },
  });
  if (!data?.success) throw cfError(status, data, "r2 bucket create");
}

/** The account's S3 endpoint for R2 (path-style; isVirtualHostedStyle
 *  auto-detects false for it). */
export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

/** Run SQL against the D1 database (schema migration). Statements are sent one
 *  at a time so a mid-script failure reports the exact statement. */
export async function d1Exec(cfg: CfApiTarget, sqlScript: string): Promise<void> {
  const statements = sqlScript
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const sql of statements) {
    const { status, data } = await cfCall(cfg, "POST", `/accounts/${cfg.accountId}/d1/database/${cfg.d1Id}/query`, {
      body: JSON.stringify({ sql }),
      headers: { "content-type": "application/json" },
    });
    if (!data?.success) throw cfError(status, data, `d1 query: ${sql.slice(0, 60)}…`);
  }
}

/** Upload the edge worker module (multipart metadata + script). Declarative
 *  `exports` + `keep_bindings:["secret_text"]` so a re-deploy never wipes the
 *  OWNER_TOKEN secret set separately below. */
export async function uploadEdgeWorker(
  cfg: CfApiTarget,
  script: string,
  deploymentId: string,
): Promise<void> {
  const metadata = {
    main_module: "edge-worker.js",
    compatibility_date: "2026-07-01",
    bindings: [
      { type: "d1", name: "DB", id: cfg.d1Id },
      // The rooms namespace (/r/<slug>/* → MhRoom). Same-script class binding.
      { type: "durable_object_namespace", name: "ROOM", class_name: "MhRoom" },
      { type: "plain_text", name: "MH_DEPLOYMENT_ID", text: deploymentId },
    ],
    keep_bindings: ["secret_text"],
    // Declarative Durable Object exports map — the source of truth for DO
    // classes (spike ⑥): re-submitting the same map is naturally idempotent,
    // and new namespaces are forced onto the SQLite backend.
    exports: { MhRoom: { type: "durable-object", storage: "sqlite" } },
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  form.append(
    "edge-worker.js",
    new Blob([script], { type: "application/javascript+module" }),
    "edge-worker.js",
  );
  const { status, data } = await cfCall(cfg, "PUT", `/accounts/${cfg.accountId}/workers/scripts/${cfg.workerName}`, {
    body: form,
  });
  if (!data?.success) throw cfError(status, data, "worker upload");
}

/** Set a secret on the worker via the dedicated secrets endpoint (spike ⑥
 *  recommendation: script re-deploys then never carry the secret in metadata). */
export async function putWorkerSecret(cfg: CfApiTarget, name: string, text: string): Promise<void> {
  const { status, data } = await cfCall(
    cfg,
    "PUT",
    `/accounts/${cfg.accountId}/workers/scripts/${cfg.workerName}/secrets`,
    {
      body: JSON.stringify({ name, text, type: "secret_text" }),
      headers: { "content-type": "application/json" },
    },
  );
  if (!data?.success) throw cfError(status, data, "worker secret");
}

/** The account's workers.dev subdomain — derives the worker's default endpoint. */
export async function workersDevSubdomain(cfg: CfApiTarget): Promise<string> {
  const { status, data } = await cfCall<{ subdomain?: string }>(
    cfg,
    "GET",
    `/accounts/${cfg.accountId}/workers/subdomain`,
  );
  if (!data?.success || !data.result?.subdomain) throw cfError(status, data, "workers.dev subdomain");
  return data.result.subdomain;
}

/** Create a dedicated D1 database and return its stable UUID. Cloudflare's
 *  conflict response is surfaced loudly; callers never adopt a same-name DB. */
export async function createD1Database(
  cfg: Pick<CfApiTarget, "accountId" | "apiToken">,
  name: string,
): Promise<{ id: string; name: string }> {
  const { status, data } = await cfCall<{ uuid?: string; id?: string; name?: string }>(
    cfg,
    "POST",
    `/accounts/${cfg.accountId}/d1/database`,
    {
      body: JSON.stringify({ name }),
      headers: { "content-type": "application/json" },
    },
  );
  if (!data?.success) {
    if (status === 409 || data?.errors?.some((e) => /exist|name/i.test(e.message ?? "")))
      throw new MhError("conflict", `D1 database "${name}" already exists; choose another name`);
    throw cfError(status, data, "d1 create");
  }
  const id = data.result?.uuid ?? data.result?.id;
  if (!id) throw new MhError("network", "Cloudflare created D1 but returned no database id");
  return { id, name: data.result?.name ?? name };
}

/** Return the account workers.dev subdomain, or null when none exists yet. */
export async function maybeWorkersDevSubdomain(cfg: CfApiTarget): Promise<string | null> {
  const { status, data } = await cfCall<{ subdomain?: string }>(
    cfg,
    "GET",
    `/accounts/${cfg.accountId}/workers/subdomain`,
  );
  if (status === 404 || (data?.success && !data.result?.subdomain)) return null;
  if (!data?.success) throw cfError(status, data, "workers.dev subdomain");
  return data.result?.subdomain ?? null;
}

/** Create the account-level workers.dev subdomain. */
export async function createWorkersDevSubdomain(
  cfg: CfApiTarget,
  subdomain: string,
): Promise<string> {
  const { status, data } = await cfCall<{ subdomain?: string }>(
    cfg,
    "PUT",
    `/accounts/${cfg.accountId}/workers/subdomain`,
    {
      body: JSON.stringify({ subdomain }),
      headers: { "content-type": "application/json" },
    },
  );
  if (!data?.success) {
    if (status === 409)
      throw new MhError("conflict", `workers.dev subdomain "${subdomain}" is unavailable`);
    throw cfError(status, data, "workers.dev subdomain create");
  }
  return data.result?.subdomain ?? subdomain;
}

/** Publish a script on the account's workers.dev domain. */
export async function enableWorkerSubdomain(cfg: CfApiTarget): Promise<void> {
  const { status, data } = await cfCall(
    cfg,
    "POST",
    `/accounts/${cfg.accountId}/workers/scripts/${cfg.workerName}/subdomain`,
    {
      body: JSON.stringify({ enabled: true }),
      headers: { "content-type": "application/json" },
    },
  );
  if (!data?.success) throw cfError(status, data, "worker subdomain enable");
}
