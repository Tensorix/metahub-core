import type { DbDriver } from "../driver.ts";
import { MhError } from "../errors.ts";
import { randomSuffix } from "../ids.ts";
import { getNodeId } from "../node.ts";
import {
  getEdgeConfig,
  getEdgeDeployProgress,
  setEdgeConfig,
  setEdgeDeployProgress,
  type CfApiTarget,
  type EdgeConfig,
} from "./edge-config.ts";
import {
  createD1Database,
  createWorkersDevSubdomain,
  d1Exec,
  d1Exists,
  enableWorkerSubdomain,
  maybeWorkersDevSubdomain,
  putWorkerSecret,
  uploadEdgeWorker,
  workerExists,
} from "./cf-api.ts";
import { EDGE_SCHEMA_SQL, EDGE_WORKER_VERSION } from "../../workers/edge-worker.ts";
import { activeDropKey, ensureDropKeys } from "./drop-keys.ts";
import { dropWiredSites } from "./drop-pull.ts";
import { syncDropWiring } from "./drop-wire.ts";
import { httpDropHost } from "./drop-host.ts";
import { listPeers } from "./peers.ts";

export interface EdgeDeployInput {
  accountId: string;
  apiToken: string;
  workerName?: string;
  d1Name?: string;
  workersSubdomain?: string;
  /** Required acknowledgment for the account-scoped remote mutations. */
  confirmed: boolean;
}

export interface EdgeDeployResult {
  endpoint: string;
  workerName: string;
  d1Id: string;
  d1Name: string;
  version: string;
  keyId: string;
  wired: { site: string; registered: boolean; error?: string }[];
}

export function defaultEdgeNames(db: DbDriver): {
  workerName: string;
  d1Name: string;
  workersSubdomain: string;
} {
  const suffix = getNodeId(db).replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-8) || randomSuffix(6);
  return {
    workerName: `metahub-edge-${suffix}`,
    d1Name: `metahub-edge-${suffix}-db`,
    workersSubdomain: `metahub-${suffix}`,
  };
}

function cleanName(value: string | undefined, fallback: string, label: string): string {
  const out = (value || fallback).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(out))
    throw new MhError("invalid_input", `${label} must use 3–64 lowercase letters, numbers, or hyphens`);
  return out;
}

/** Create/upgrade a dedicated Worker+D1. Progress is persisted before every
 * remote effect, while the API token exists only in this stack frame. */
export async function deployEdge(
  db: DbDriver,
  input: EdgeDeployInput,
  workerScript: string,
): Promise<EdgeDeployResult> {
  if (!input.confirmed)
    throw new MhError("invalid_input", "confirm the Cloudflare resource creation first");
  if (!input.accountId.trim() || !input.apiToken.trim())
    throw new MhError("invalid_input", "Cloudflare account id and API token are required");

  const defaults = defaultEdgeNames(db);
  const accountId = input.accountId.trim();
  const workerName = cleanName(input.workerName, defaults.workerName, "Worker name");
  const d1Name = cleanName(input.d1Name, defaults.d1Name, "D1 name");
  const previous = getEdgeConfig(db);
  const pending = getEdgeDeployProgress(db);
  const owned =
    previous?.cf?.accountId === accountId &&
    previous.cf.workerName === workerName;
  const resumable =
    pending?.accountId === accountId &&
    pending.workerName === workerName &&
    pending.d1Name === d1Name;
  if (owned && previous?.cf?.d1Name && previous.cf.d1Name !== d1Name)
    throw new MhError(
      "conflict",
      `Worker "${workerName}" is already bound to D1 "${previous.cf.d1Name}"; keep that name or choose a new Worker`,
    );

  const base = {
    accountId,
    apiToken: input.apiToken.trim(),
    workerName,
  };
  const lookup = { ...base, d1Id: previous?.cf?.d1Id ?? pending?.d1Id ?? "pending" };
  if ((await workerExists(lookup)) && !owned && !resumable)
    throw new MhError("conflict", `Worker "${workerName}" already exists and is not owned by this deployment`);

  let d1Id = owned ? previous!.cf!.d1Id : resumable ? pending!.d1Id : undefined;
  if (d1Id) {
    const target = { ...base, d1Id };
    if (!(await d1Exists(target)))
      throw new MhError("not_found", `recorded D1 database ${d1Id} no longer exists`);
  } else {
    setEdgeDeployProgress(db, {
      accountId: base.accountId,
      workerName,
      d1Name,
      step: "creating_d1",
      updatedAt: Date.now(),
    });
    d1Id = (await createD1Database(base, d1Name)).id;
    setStep(db, "creating_subdomain", {
      accountId: base.accountId,
      workerName,
      d1Name,
      d1Id,
    });
  }

  const target: CfApiTarget = { ...base, d1Id, d1Name };
  const progress = (step: Parameters<typeof setStep>[1], workersSubdomain?: string) =>
    setStep(db, step, { accountId: base.accountId, workerName, d1Name, d1Id, workersSubdomain });

  let subdomain = await maybeWorkersDevSubdomain(target);
  if (!subdomain) {
    const wanted = cleanName(input.workersSubdomain, defaults.workersSubdomain, "workers.dev subdomain");
    progress("creating_subdomain", wanted);
    subdomain = await createWorkersDevSubdomain(target, wanted);
  }

  progress("migrating_d1", subdomain);
  await d1Exec(target, EDGE_SCHEMA_SQL);
  progress("uploading_worker", subdomain);
  await uploadEdgeWorker(target, workerScript);
  const token = previous?.token ?? "drt_" + randomSuffix(32);
  progress("setting_secret", subdomain);
  await putWorkerSecret(target, "OWNER_TOKEN", token);
  progress("enabling_subdomain", subdomain);
  await enableWorkerSubdomain(target);

  const endpoint = `https://${workerName}.${subdomain}.workers.dev`;
  await ensureDropKeys(db);
  const cfg: EdgeConfig = {
    endpoint,
    token,
    cf: { accountId: base.accountId, workerName, d1Id, d1Name, workersSubdomain: subdomain },
    deployedVersion: EDGE_WORKER_VERSION,
  };
  setEdgeConfig(db, cfg);
  setEdgeDeployProgress(db, null);

  const wired: EdgeDeployResult["wired"] = [];
  for (const site of dropWiredSites(db)) {
    const result = await syncDropWiring(db, site).catch((e) => ({
      registered: false,
      registerError: (e as Error).message,
    }));
    wired.push({
      site: site.name,
      registered: !!result.registered,
      ...(result.registerError ? { error: result.registerError } : {}),
    });
  }
  return {
    endpoint,
    workerName,
    d1Id,
    d1Name,
    version: EDGE_WORKER_VERSION,
    keyId: activeDropKey(await ensureDropKeys(db)).key_id,
    wired,
  };
}

function setStep(
  db: DbDriver,
  step: NonNullable<ReturnType<typeof getEdgeDeployProgress>>["step"],
  base: Omit<NonNullable<ReturnType<typeof getEdgeDeployProgress>>, "step" | "updatedAt">,
): void {
  setEdgeDeployProgress(db, { ...base, step, updatedAt: Date.now() });
}

export async function connectEdge(
  db: DbDriver,
  endpointInput: string,
  token: string,
): Promise<EdgeStatus> {
  let endpoint: string;
  try {
    const parsed = new URL(endpointInput.trim());
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost")
      throw new Error("Edge endpoint must use HTTPS");
    endpoint = parsed.toString().replace(/\/+$/, "");
  } catch (e) {
    throw new MhError("invalid_input", (e as Error).message || "invalid Edge endpoint");
  }
  if (!token.trim()) throw new MhError("invalid_input", "owner token is required");
  const health = await httpDropHost(endpoint, token.trim()).ownerHealth();
  if (!health.ok) throw new MhError("network", `Edge at ${endpoint} is not healthy`);
  if (health.version !== EDGE_WORKER_VERSION)
    throw new MhError(
      "conflict",
      `Edge version ${health.version ?? "unknown"} is incompatible; expected ${EDGE_WORKER_VERSION}`,
    );
  await ensureDropKeys(db);
  setEdgeConfig(db, { endpoint, token: token.trim(), deployedVersion: health.version });
  for (const site of dropWiredSites(db)) await syncDropWiring(db, site).catch(() => undefined);
  return edgeStatus(db);
}

export interface EdgeRoomStatus {
  slug: string;
  url: string;
  status: string | null;
  lastSuccessAt: number | null;
  error: string | null;
}

export interface EdgeStatus {
  configured: boolean;
  endpoint?: string;
  version?: string | null;
  expectedVersion: string;
  aligned: boolean;
  reachable: boolean;
  error?: string;
  managed: boolean;
  deployment?: {
    accountId: string;
    workerName: string;
    d1Name: string;
    workersSubdomain: string;
  };
  rooms: EdgeRoomStatus[];
  defaults: ReturnType<typeof defaultEdgeNames>;
  pending: ReturnType<typeof getEdgeDeployProgress>;
}

export async function edgeStatus(db: DbDriver): Promise<EdgeStatus> {
  const cfg = getEdgeConfig(db);
  const defaults = defaultEdgeNames(db);
  const deployment = cfg?.cf
    ? {
        accountId: cfg.cf.accountId,
        workerName: cfg.cf.workerName,
        d1Name: cfg.cf.d1Name ?? defaults.d1Name,
        workersSubdomain: cfg.cf.workersSubdomain ?? defaults.workersSubdomain,
      }
    : undefined;
  const rooms = listPeers(db)
    .filter((p) => p.kind === "room" && p.config)
    .map((p) => {
      const rc = JSON.parse(p.config!) as { base: string; slug: string };
      return {
        slug: rc.slug,
        url: `${rc.base.replace(/\/+$/, "")}/r/${rc.slug}/`,
        status: p.last_status,
        lastSuccessAt: p.last_success_at,
        error: p.last_error,
      };
    });
  if (!cfg)
    return {
      configured: false,
      expectedVersion: EDGE_WORKER_VERSION,
      aligned: false,
      reachable: false,
      managed: false,
      rooms,
      defaults,
      pending: getEdgeDeployProgress(db),
    };
  try {
    const health = await httpDropHost(cfg.endpoint, cfg.token).ownerHealth();
    return {
      configured: true,
      endpoint: cfg.endpoint,
      version: health.version ?? null,
      expectedVersion: EDGE_WORKER_VERSION,
      aligned: health.version === EDGE_WORKER_VERSION,
      reachable: health.ok,
      managed: !!cfg.cf,
      ...(deployment ? { deployment } : {}),
      rooms,
      defaults,
      pending: getEdgeDeployProgress(db),
    };
  } catch (e) {
    return {
      configured: true,
      endpoint: cfg.endpoint,
      version: null,
      expectedVersion: EDGE_WORKER_VERSION,
      aligned: false,
      reachable: false,
      error: (e as Error).message,
      managed: !!cfg.cf,
      ...(deployment ? { deployment } : {}),
      rooms,
      defaults,
      pending: getEdgeDeployProgress(db),
    };
  }
}

export function disconnectEdge(db: DbDriver): void {
  const rooms = listPeers(db).filter((p) => p.kind === "room");
  if (rooms.length)
    throw new MhError("conflict", `revoke ${rooms.length} active room(s) before disconnecting Edge`);
  setEdgeConfig(db, null);
  setEdgeDeployProgress(db, null);
}
