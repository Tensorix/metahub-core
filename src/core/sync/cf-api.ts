// Thin Cloudflare REST wrapper for `mh edge deploy` — the node half of the
// edge worker pipeline. Scope discipline (design.md §7 red line 7): every call
// here either READS existence or WRITES CONTENT INTO a resource the user named
// (script body, D1 rows, a secret); there is no create-service call in this
// file, deliberately. Deployment uses the declarative `exports` metadata field
// (spike ⑥): the exports map is the source of truth and re-submitting the same
// map is naturally idempotent — no migration tag bookkeeping. The map carries
// the MhRoom Durable Object class (share rooms, Stage C).
//
// Honesty note surfaced by the CLI: Cloudflare API tokens scope to the ACCOUNT
// (Workers Scripts Edit has no per-script granularity), so "only touches the
// named resources" is a behavioral promise auditable in this source, not a
// token-enforced one.

import { MhError } from "../errors.ts";
import type { CfEdgeTarget } from "./edge-config.ts";

const CF_API = "https://api.cloudflare.com/client/v4";

interface CfResult<T> {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

async function cfCall<T>(
  cfg: CfEdgeTarget,
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

/** Does the named Worker script exist? (mh never creates it — the user does,
 *  in the Cloudflare dashboard.) */
export async function workerExists(cfg: CfEdgeTarget): Promise<boolean> {
  const { status, data } = await cfCall(
    cfg,
    "GET",
    `/accounts/${cfg.accountId}/workers/scripts/${cfg.workerName}/settings`,
  );
  if (status === 404) return false;
  if (!data?.success) throw cfError(status, data, "worker lookup");
  return true;
}

/** Does the named D1 database exist? */
export async function d1Exists(cfg: CfEdgeTarget): Promise<boolean> {
  const { status, data } = await cfCall(cfg, "GET", `/accounts/${cfg.accountId}/d1/database/${cfg.d1Id}`);
  if (status === 404) return false;
  if (!data?.success) throw cfError(status, data, "d1 lookup");
  return true;
}

/** Run SQL against the D1 database (schema migration). Statements are sent one
 *  at a time so a mid-script failure reports the exact statement. */
export async function d1Exec(cfg: CfEdgeTarget, sqlScript: string): Promise<void> {
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
export async function uploadEdgeWorker(cfg: CfEdgeTarget, script: string): Promise<void> {
  const metadata = {
    main_module: "edge-worker.js",
    compatibility_date: "2026-07-01",
    bindings: [
      { type: "d1", name: "DB", id: cfg.d1Id },
      // The rooms namespace (/r/<slug>/* → MhRoom). Same-script class binding.
      { type: "durable_object_namespace", name: "ROOM", class_name: "MhRoom" },
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
export async function putWorkerSecret(cfg: CfEdgeTarget, name: string, text: string): Promise<void> {
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
export async function workersDevSubdomain(cfg: CfEdgeTarget): Promise<string> {
  const { status, data } = await cfCall<{ subdomain?: string }>(
    cfg,
    "GET",
    `/accounts/${cfg.accountId}/workers/subdomain`,
  );
  if (!data?.success || !data.result?.subdomain) throw cfError(status, data, "workers.dev subdomain");
  return data.result.subdomain;
}
