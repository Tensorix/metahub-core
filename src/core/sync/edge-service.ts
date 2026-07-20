import type { DbDriver } from "../driver.ts";
import { MhError } from "../errors.ts";
import { randomSuffix } from "../ids.ts";
import { getNodeId } from "../node.ts";
import {
  getEdgeConfig,
  getEdgeDeployProgress,
  edgeCapabilities,
  setEdgeConfig,
  setEdgeDeployProgress,
  type CfApiTarget,
  type EdgeConfig,
} from "./edge-config.ts";
import {
  createD1Database,
  createWorkersDevSubdomain,
  d1DatabasesByName,
  d1Exec,
  d1Exists,
  enableWorkerSubdomain,
  maybeWorkersDevSubdomain,
  putWorkerSecret,
  uploadEdgeWorker,
  workerDeployment,
} from "./cf-api.ts";
import { EDGE_SCHEMA_SQL, EDGE_WORKER_VERSION } from "../../workers/edge-worker.ts";
import { activeDropKey, ensureDropKeys } from "./drop-keys.ts";
import { dropWiredSites } from "./drop-pull.ts";
import { syncDropWiring } from "./drop-wire.ts";
import { httpDropHost } from "./drop-host.ts";
import { verifyEdgeConnection } from "./edge-connect.ts";
import { listPeers } from "./peers.ts";
import { roomUrlOf } from "./room-url.ts";

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
  status: "deployed";
  endpoint: string;
  workerName: string;
  d1Id: string;
  d1Name: string;
  version: string;
  keyId: string;
  wired: { site: string; registered: boolean; error?: string }[];
  warnings: string[];
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
  const deploymentId =
    (owned ? previous?.cf?.deploymentId : undefined) ||
    (resumable ? pending?.deploymentId : undefined) ||
    `edge_${randomSuffix(16)}`;
  const startedAt = (resumable ? pending?.startedAt : undefined) || Date.now();
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
  const worker = await workerDeployment(lookup);
  if (worker.exists && !owned && worker.deploymentId !== deploymentId)
    throw new MhError(
      "conflict",
      `Worker "${workerName}" already exists and is not owned by this deployment`,
    );

  let d1Id = owned ? previous!.cf!.d1Id : resumable ? pending!.d1Id : undefined;
  if (d1Id) {
    const target = { ...base, d1Id };
    if (!(await d1Exists(target)))
      throw new MhError("not_found", `recorded D1 database ${d1Id} no longer exists`);
  } else {
    const named = await d1DatabasesByName(base, d1Name);
    if (!resumable && named.length)
      throw new MhError("conflict", `D1 database "${d1Name}" already exists and is not owned by this deployment`);
    if (resumable && named.length) {
      if (named.length !== 1)
        throw new MhError("conflict", `multiple D1 databases matched "${d1Name}"; refusing to adopt one`);
      const created = named[0]!.createdAt ? Date.parse(named[0]!.createdAt!) : Number.NaN;
      if (!Number.isFinite(created) || created + 5_000 < startedAt)
        throw new MhError(
          "conflict",
          `D1 database "${d1Name}" predates this deployment; refusing to adopt it`,
        );
      d1Id = named[0]!.id;
    } else {
      setEdgeDeployProgress(db, {
        accountId: base.accountId,
        workerName,
        d1Name,
        deploymentId,
        startedAt,
        step: "creating_d1",
        updatedAt: Date.now(),
      });
      d1Id = (await createD1Database(base, d1Name)).id;
    }
    setStep(db, "creating_subdomain", {
      accountId: base.accountId,
      workerName,
      d1Name,
      d1Id,
      deploymentId,
      startedAt,
    });
  }

  const target: CfApiTarget = { ...base, d1Id, d1Name, deploymentId };
  const progress = (step: Parameters<typeof setStep>[1], workersSubdomain?: string) =>
    setStep(db, step, {
      accountId: base.accountId,
      workerName,
      d1Name,
      d1Id,
      workersSubdomain,
      deploymentId,
      startedAt,
    });

  const warnings: string[] = [];
  let subdomain = await maybeWorkersDevSubdomain(target);
  if (!subdomain) {
    const wanted = cleanName(input.workersSubdomain, defaults.workersSubdomain, "workers.dev subdomain");
    progress("creating_subdomain", wanted);
    subdomain = await createWorkersDevSubdomain(target, wanted);
  } else if (input.workersSubdomain && input.workersSubdomain.trim() !== subdomain) {
    warnings.push(`Cloudflare account already uses workers.dev subdomain "${subdomain}"; requested value was ignored`);
  }

  progress("migrating_d1", subdomain);
  await d1Exec(target, EDGE_SCHEMA_SQL);
  progress("uploading_worker", subdomain);
  await uploadEdgeWorker(target, workerScript, deploymentId);
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
    capabilities: ["inbox", "room"],
    cf: {
      accountId: base.accountId,
      workerName,
      d1Id,
      d1Name,
      workersSubdomain: subdomain,
      deploymentId,
    },
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
    status: "deployed",
    endpoint,
    workerName,
    d1Id,
    d1Name,
    version: EDGE_WORKER_VERSION,
    keyId: activeDropKey(await ensureDropKeys(db)).key_id,
    wired,
    warnings,
  };
}

function setStep(
  db: DbDriver,
  step: NonNullable<ReturnType<typeof getEdgeDeployProgress>>["step"],
  base: Omit<NonNullable<ReturnType<typeof getEdgeDeployProgress>>, "step" | "updatedAt">,
): void {
  setEdgeDeployProgress(db, { ...base, step, updatedAt: Date.now() });
}

export interface EdgeConnectResult extends EdgeStatus {
  status: "connected";
  wired: { site: string; registered: boolean; error?: string }[];
  warnings: string[];
}

export async function connectEdge(
  db: DbDriver,
  endpointInput: string,
  token: string,
): Promise<EdgeConnectResult> {
  const verified = await verifyEdgeConnection(endpointInput, token, "edge");
  await ensureDropKeys(db);
  setEdgeConfig(db, {
    endpoint: verified.endpoint,
    token: verified.token,
    capabilities: verified.capabilities,
    deployedVersion: verified.version,
  });
  const wired = await rewireSites(db);
  return { ...(await edgeStatus(db)), status: "connected", wired, warnings: [] };
}

/** CLI-only compatibility path for any host implementing the inbox protocol.
 * It deliberately does not claim Room capability or require our Worker version. */
export async function connectInboxHost(
  db: DbDriver,
  endpointInput: string,
  token: string,
): Promise<EdgeConnectResult> {
  const verified = await verifyEdgeConnection(endpointInput, token, "inbox");
  await ensureDropKeys(db);
  setEdgeConfig(db, {
    endpoint: verified.endpoint,
    token: verified.token,
    capabilities: verified.capabilities,
    deployedVersion: verified.version,
  });
  const wired = await rewireSites(db);
  return { ...(await edgeStatus(db)), status: "connected", wired, warnings: [] };
}

async function rewireSites(
  db: DbDriver,
): Promise<{ site: string; registered: boolean; error?: string }[]> {
  const wired: { site: string; registered: boolean; error?: string }[] = [];
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
  return wired;
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
  capabilities?: ("inbox" | "room")[];
  wired?: { site: string; registered: boolean; error?: string }[];
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
      const lifecycle = (rc as { lifecycle?: string }).lifecycle ?? "active";
      return {
        slug: rc.slug,
        url: roomUrlOf(rc),
        status: lifecycle === "active" ? p.last_status : lifecycle,
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
    const capabilities = edgeCapabilities(cfg);
    const roomCapable = capabilities.includes("room");
    const host = httpDropHost(cfg.endpoint, cfg.token);
    const health = roomCapable ? await host.ownerHealth() : await host.health();
    return {
      configured: true,
      endpoint: cfg.endpoint,
      capabilities,
      version: health.version ?? null,
      expectedVersion: EDGE_WORKER_VERSION,
      aligned: roomCapable ? health.version === EDGE_WORKER_VERSION : true,
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
      capabilities: edgeCapabilities(cfg),
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
