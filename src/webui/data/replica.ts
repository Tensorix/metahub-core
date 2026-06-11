// Main-thread client for the browser replica: app-facing status store, the
// enable/disable (pair/unpair) flows, DOM event fan-out, and the service
// worker bridge. Transport — who owns the DB worker, cross-tab proxying — is
// ReplicaBus (replica-bus.ts): this tab is either the leader (direct worker)
// or a follower (BroadcastChannel to the leader), decided by a Web Lock.
// The decision of WHEN to route reads/writes locally lives in local-api.ts.

import { authFetch, NAV_INVALIDATE } from "../api.ts";
import { getReplicaBus, BusError } from "./replica-bus.ts";
import type { ReplicaStatus, WorkerEvent } from "./db-worker.ts";

/** Fired on `document` after a sync pulled remote changes; detail carries
 *  `{ datasets, rowIds }` so open views can refresh what they show. */
export const SYNCED_EVENT = "mh-synced";

const ENABLED_KEY = "mh_replica";
const HYDRATED_KEY = "mh_replica_hydrated";

export class ReplicaError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "ReplicaError";
  }
}

let started = false;
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

/** Route reads/writes locally only when the replica is running AND has
 *  completed at least one full sync — before that the local DB would show an
 *  empty (or stale-partial) hub, which is worse than staying online. */
export function replicaActive(): boolean {
  return replicaEnabled() && flag(HYDRATED_KEY) && started && status.state !== "error";
}

function handleEvent(d: WorkerEvent): void {
  if (d.event === "status") {
    status = d.status;
    if (status.lastSync?.ok && !flag(HYDRATED_KEY)) {
      setFlag(HYDRATED_KEY, true);
      // Ask the browser not to evict the freshly hydrated replica under
      // storage pressure (Chrome/Firefox honor this; Safari ties persistence
      // to home-screen installs).
      void navigator.storage?.persist?.().catch(() => {});
    }
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

/** Join the replica bus (idempotent): leadership election happens inside the
 *  bus; this wires events, sync triggers, and the SW bridge for this tab. */
export function startReplica(): void {
  if (started || typeof Worker === "undefined") return;
  started = true;
  const bus = getReplicaBus();
  bus.onEvent(handleEvent);
  bus.start();
  // Late joiner (follower tab): pull the current status once instead of
  // waiting for the next transition broadcast.
  void bus
    .call<ReplicaStatus>("status")
    .then((s) => handleEvent({ event: "status", status: s }))
    .catch(() => {});
  installSwBridge();
  window.addEventListener("online", requestSync);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestSync();
  });
}

export function call<T>(op: string, ...args: unknown[]): Promise<T> {
  if (!started) return Promise.reject(new ReplicaError("replica not running", undefined));
  return getReplicaBus()
    .call<T>(op, ...args)
    .catch((e) => {
      throw e instanceof BusError ? new ReplicaError(e.message, e.code) : e;
    });
}

export function requestSync(): void {
  if (started && status.paired) void call("sync").catch(() => {});
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

/** Enable offline replica for this browser: join the bus, self-pair (the page
 *  already holds the master token, so it mints the one-time code itself), then
 *  kick off hydration. Resolves once pairing succeeds — hydration progress
 *  streams via status events. */
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
    if (started) await call("unpair");
  } catch {
    /* worker may be dead; flags above already make this browser HTTP-only */
  }
}

/** Wipe the local replica entirely (settings → 重置本地副本): close + delete
 *  the OPFS database. Re-enabling afterwards re-pairs and re-hydrates. */
export async function resetReplica(): Promise<void> {
  setFlag(ENABLED_KEY, false);
  setFlag(HYDRATED_KEY, false);
  try {
    if (started) {
      await call("unpair").catch(() => {});
      await call("reset");
    }
  } finally {
    getReplicaBus().stopWorker();
  }
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

// ---- service worker bridge ----------------------------------------------------

/**
 * Answer the SW's offline gateway: it forwards /api/* (and /sites/*) requests
 * it couldn't reach the server with as `{ kind: "mh-rpc", op, args }` messages
 * carrying a MessagePort. Any page on the origin can answer (the bus routes to
 * the leader); a tab without an active replica replies "unavailable" so the SW
 * can try another client. Shared-flag-guarded: the injected /mh-runtime.js
 * installs the same bridge on hosted site pages, and a page must answer once.
 */
function installSwBridge(): void {
  const g = globalThis as { __mhSwBridge?: boolean };
  if (g.__mhSwBridge || !("serviceWorker" in navigator)) return;
  g.__mhSwBridge = true;
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { kind?: string; op?: string; args?: unknown[] } | null;
    const port = e.ports?.[0];
    if (!d || d.kind !== "mh-rpc" || !port || !d.op) return;
    if (!replicaActive()) {
      port.postMessage({ ok: false, error: { message: "replica unavailable", code: "unavailable" } });
      return;
    }
    call(d.op, ...(d.args ?? [])).then(
      (result) => port.postMessage({ ok: true, result }),
      (err: ReplicaError) =>
        port.postMessage({ ok: false, error: { message: err.message, code: err.code } }),
    );
  });
}
