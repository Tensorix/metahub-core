// Edge (write-inbox host) configuration, persisted in the node-local `meta`
// table — same trust model and storage pattern as ServerConfig (core/config.ts)
// and peers.config: machine-local, never enters the oplog, never syncs. The
// command face is `mh edge ...`; no peer row is created (the edge host is not a
// sync peer — devices never read data from it, only mail).

import type { DbDriver } from "../driver.ts";

/** Shared without importing the Worker bundle into browser/Node clients. */
export const EXPECTED_EDGE_WORKER_VERSION = "3";
export type EdgeCapability = "inbox" | "room";

/** Persisted Cloudflare resource identity. Deliberately excludes the account
 *  API token: deploy/upgrade callers must supply that ephemeral credential. */
export interface CfEdgeTarget {
  accountId: string;
  workerName: string;
  d1Id: string;
  d1Name?: string;
  workersSubdomain?: string;
  /** Non-secret marker also uploaded with the Worker, used to distinguish a
   * resumable deployment from an unrelated same-name script. */
  deploymentId?: string;
}

export interface CfApiTarget extends CfEdgeTarget {
  apiToken: string;
}

export interface EdgeConfig {
  /** Base URL of the inbox host (workers.dev URL, or any compatible host). */
  endpoint: string;
  /** Owner secret ("drt_…") — independent of the master token so a leaked
   *  inbox credential can only read/ack ciphertext mail, nothing else. */
  token: string;
  /** Third-party inbox hosts need not implement MetaHub Room APIs. */
  capabilities?: EdgeCapability[];
  /** Present when the host is a CF worker managed by `mh edge deploy`. */
  cf?: CfEdgeTarget;
  /** EDGE_WORKER_VERSION at last deploy — `mh edge status` alignment check. */
  deployedVersion?: string;
}

const CONFIG_KEY = "edge_config";
const DEPLOY_KEY = "edge_deploy_progress";
const KNOBS_PREFIX = "drop_knobs:";

function getMeta(db: DbDriver, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row ? row.value : null;
}

function setMeta(db: DbDriver, key: string, value: string | null): void {
  if (value === null) {
    db.query("DELETE FROM meta WHERE key = ?").run(key);
    return;
  }
  db.query(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function getEdgeConfig(db: DbDriver): EdgeConfig | null {
  const raw = getMeta(db, CONFIG_KEY);
  if (!raw) return null;
  try {
    const cfg = JSON.parse(raw) as Partial<EdgeConfig> & {
      endpoint?: string;
      token?: string;
      cf?: CfEdgeTarget & { apiToken?: string };
    };
    if (!cfg || typeof cfg.endpoint !== "string" || typeof cfg.token !== "string") return null;
    // Read-time migration for configs written by older releases. The secret is
    // removed immediately so merely starting the upgraded app fixes storage.
    if (cfg.cf && "apiToken" in cfg.cf) {
      delete cfg.cf.apiToken;
      setMeta(db, CONFIG_KEY, JSON.stringify(cfg));
    }
    if (!Array.isArray(cfg.capabilities)) {
      // Released pre-Room configs represented the CLI's generic inbox host.
      // Managed Cloudflare deployments are the only legacy rows known to run
      // the bundled Worker and therefore safely gain Room support.
      cfg.capabilities = cfg.cf ? ["inbox", "room"] : ["inbox"];
      setMeta(db, CONFIG_KEY, JSON.stringify(cfg));
    }
    return cfg as EdgeConfig;
  } catch {
    return null;
  }
}

export function setEdgeConfig(db: DbDriver, cfg: EdgeConfig | null): void {
  if (cfg?.cf && "apiToken" in cfg.cf)
    throw new Error("Cloudflare API token must not be persisted");
  const normalized = cfg
    ? { ...cfg, capabilities: cfg.capabilities ?? (cfg.cf ? ["inbox", "room"] : ["inbox"]) }
    : null;
  setMeta(db, CONFIG_KEY, normalized ? JSON.stringify(normalized) : null);
}

export function edgeCapabilities(cfg: EdgeConfig): EdgeCapability[] {
  return cfg.capabilities ?? (cfg.cf ? ["inbox", "room"] : ["inbox"]);
}

export type EdgeDeployStep =
  | "creating_d1"
  | "creating_subdomain"
  | "uploading_worker"
  | "migrating_d1"
  | "setting_secret"
  | "enabling_subdomain";

export interface EdgeDeployProgress {
  accountId: string;
  workerName: string;
  d1Name: string;
  d1Id?: string;
  workersSubdomain?: string;
  deploymentId: string;
  startedAt: number;
  step: EdgeDeployStep;
  updatedAt: number;
}

export function getEdgeDeployProgress(db: DbDriver): EdgeDeployProgress | null {
  const raw = getMeta(db, DEPLOY_KEY);
  if (!raw) return null;
  try {
    const progress = JSON.parse(raw) as Partial<EdgeDeployProgress>;
    if (
      typeof progress.accountId !== "string" ||
      typeof progress.workerName !== "string" ||
      typeof progress.d1Name !== "string" ||
      typeof progress.step !== "string"
    )
      return null;
    return {
      ...progress,
      // Legacy pending rows cannot prove Worker ownership, so the empty marker
      // will never match a remote Worker. They may still safely resume before
      // the Worker-upload step.
      deploymentId: progress.deploymentId ?? "",
      startedAt: progress.startedAt ?? progress.updatedAt ?? Date.now(),
      updatedAt: progress.updatedAt ?? Date.now(),
    } as EdgeDeployProgress;
  } catch {
    return null;
  }
}

export function setEdgeDeployProgress(db: DbDriver, progress: EdgeDeployProgress | null): void {
  setMeta(db, DEPLOY_KEY, progress ? JSON.stringify(progress) : null);
}

/** In-flight R2 bucket provisioning (edge-service provisionR2Bucket). Persisted
 *  BEFORE the remote create so a crash mid-flight can prove on re-run that the
 *  half-created bucket is OURS to adopt (the R2 API has no ownership marker). */
export interface R2ProvisionProgress {
  accountId: string;
  bucketName: string;
  startedAt: number;
}

const R2_PROVISION_KEY = "edge_r2_provision_progress";

export function getR2ProvisionProgress(db: DbDriver): R2ProvisionProgress | null {
  const raw = getMeta(db, R2_PROVISION_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<R2ProvisionProgress>;
    if (typeof p.accountId !== "string" || typeof p.bucketName !== "string") return null;
    return { accountId: p.accountId, bucketName: p.bucketName, startedAt: p.startedAt ?? 0 };
  } catch {
    return null;
  }
}

export function setR2ProvisionProgress(db: DbDriver, progress: R2ProvisionProgress | null): void {
  setMeta(db, R2_PROVISION_KEY, progress ? JSON.stringify(progress) : null);
}

/**
 * Per-site anti-abuse knobs, set on `mh site grant … --turnstile/--password`.
 * They gate BOTH guest-write transports of the same grant: the write-inbox
 * (enforced at the edge worker) and the server's realtime granted endpoint.
 * The password itself is never stored — only a PBKDF2 salt (published in
 * mh-drop.json so the page can derive the verifier) and the verifier (sent to
 * the edge registration for constant-time comparison).
 */
export interface DropKnobs {
  turnstileSitekey?: string;
  /** Turnstile SECRET key — needed by the edge for siteverify; never published. */
  turnstileSecret?: string;
  passwordSalt?: string; // base64
  passwordVerifier?: string; // base64 PBKDF2 output
}

export function getDropKnobs(db: DbDriver, siteId: string): DropKnobs | null {
  const raw = getMeta(db, KNOBS_PREFIX + siteId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DropKnobs;
  } catch {
    return null;
  }
}

export function setDropKnobs(db: DbDriver, siteId: string, knobs: DropKnobs | null): void {
  const empty = !knobs || Object.values(knobs).every((v) => v == null);
  setMeta(db, KNOBS_PREFIX + siteId, empty ? null : JSON.stringify(knobs));
}
