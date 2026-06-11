// Main-thread client for the browser replica (db-worker.ts): worker lifecycle,
// RPC plumbing, status tracking, and the enable/disable (pair/unpair) flows.
// The decision of WHEN to route reads/writes here lives in local-api.ts; this
// module only manages the channel.
//
// Single-instance by design: opfs-sahpool allows one open connection per
// origin, so a second tab's worker fails to boot, lands in state "error", and
// that tab keeps using the HTTP api. (Web Locks leader election is the
// planned upgrade — see docs/system-design.)

import { authFetch, NAV_INVALIDATE } from "../api.ts";
import type { RpcResponse, ReplicaStatus, WorkerEvent } from "./db-worker.ts";

/** Fired on `document` after a sync pulled remote changes; detail carries
 *  `{ datasets, rowIds }` so open views can refresh what they show. */
export const SYNCED_EVENT = "mh-synced";

const ENABLED_KEY = "mh_replica";
const HYDRATED_KEY = "mh_replica_hydrated";

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

export class ReplicaError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "ReplicaError";
  }
}

let status: ReplicaStatus = { state: "booting", paired: false, node: null };
const statusListeners = new Set<(s: ReplicaStatus) => void>();

export function replicaStatus(): ReplicaStatus {
  return status;
}
export function onReplicaStatus(fn: (s: ReplicaStatus) => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

function flag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function setFlag(key: string, on: boolean): void {
  try {
    on ? localStorage.setItem(key, "1") : localStorage.removeItem(key);
  } catch {
    /* private mode */
  }
}

export function replicaEnabled(): boolean {
  return flag(ENABLED_KEY);
}

/** Route reads/writes locally only when the worker is alive AND the replica
 *  has completed at least one full sync — before that the local DB would show
 *  an empty (or stale-partial) hub, which is worse than staying online. */
export function replicaActive(): boolean {
  return replicaEnabled() && flag(HYDRATED_KEY) && worker != null && status.state !== "error";
}

function handleMessage(e: MessageEvent): void {
  const d = e.data as RpcResponse | WorkerEvent;
  if ("id" in d) {
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.ok) p.resolve(d.result);
    else p.reject(new ReplicaError(d.error.message, d.error.code));
    return;
  }
  if (d.event === "status") {
    status = d.status;
    if (d.status.lastSync?.ok) setFlag(HYDRATED_KEY, true);
    for (const fn of statusListeners) fn(status);
    return;
  }
  if (d.event === "synced") {
    document.dispatchEvent(new CustomEvent(SYNCED_EVENT, { detail: d }));
    if (d.datasets.some((ds) => ds === "databases" || ds === "documents")) {
      document.dispatchEvent(new CustomEvent(NAV_INVALIDATE));
    }
  }
}

/** Spawn the worker (idempotent). Boot failures surface via status. */
export function startReplica(): void {
  if (worker || typeof Worker === "undefined") return;
  status = { state: "booting", paired: false, node: null };
  worker = new Worker("/db-worker.js", { type: "module" });
  worker.onmessage = handleMessage;
  worker.onerror = () => {
    status = { ...status, state: "error", error: "worker crashed" };
    for (const fn of statusListeners) fn(status);
  };
  // Nudge a sync whenever connectivity or visibility return.
  window.addEventListener("online", requestSync);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestSync();
  });
}

export function call<T>(op: string, ...args: unknown[]): Promise<T> {
  if (!worker) return Promise.reject(new ReplicaError("replica not running", undefined));
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ id, op, args });
  });
}

export function requestSync(): void {
  if (worker && status.paired) void call("sync").catch(() => {});
}

function waitReady(timeoutMs = 30_000): Promise<void> {
  if (status.state === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new ReplicaError("本地副本启动超时", undefined));
    }, timeoutMs);
    const off = onReplicaStatus((s) => {
      if (s.state === "ready") {
        clearTimeout(timer);
        off();
        resolve();
      } else if (s.state === "error") {
        clearTimeout(timer);
        off();
        reject(new ReplicaError(s.error ?? "本地副本启动失败", undefined));
      }
    });
  });
}

/** Enable offline replica for this browser: boot the worker, self-pair (the
 *  page already holds the master token, so it mints the one-time code itself),
 *  then kick off hydration. Resolves once pairing succeeds — hydration
 *  progress streams via status events. */
export async function enableReplica(): Promise<void> {
  startReplica();
  await waitReady();
  if (!status.paired) {
    const res = await authFetch("/api/pair/new", { method: "POST" });
    if (!res.ok) throw new ReplicaError(`无法获取配对码: ${res.status}`, undefined);
    const { code } = (await res.json()) as { code: string };
    await call("pair", code);
  }
  setFlag(ENABLED_KEY, true);
  requestSync();
}

/** Disable: unpair (best-effort) and stop routing locally. The OPFS database
 *  is kept — re-enabling later re-pairs and resumes from its cursors. */
export async function disableReplica(): Promise<void> {
  setFlag(ENABLED_KEY, false);
  setFlag(HYDRATED_KEY, false);
  try {
    if (worker) await call("unpair");
  } catch {
    /* worker may be dead; flags above already make this browser HTTP-only */
  }
  worker?.terminate();
  worker = null;
  pending.forEach((p) => p.reject(new ReplicaError("replica stopped", undefined)));
  pending.clear();
  status = { state: "booting", paired: false, node: null };
}

/** Boot path for app startup: resume the replica if this browser enabled it. */
export function resumeReplicaIfEnabled(): void {
  if (replicaEnabled()) {
    startReplica();
    void waitReady()
      .then(() => requestSync())
      .catch(() => {});
  }
}
