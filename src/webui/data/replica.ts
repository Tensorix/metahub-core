// Main-thread client for the browser replica: app-facing status store, the
// enable/disable (pair/unpair) flows, DOM event fan-out, and the service
// worker bridge. Transport — who owns the DB worker, cross-tab proxying — is
// ReplicaBus (replica-bus.ts): this tab is either the leader (direct worker)
// or a follower (BroadcastChannel to the leader), decided by a Web Lock.
// The decision of WHEN to route reads/writes locally lives in local-api.ts.

import { authFetch, NAV_INVALIDATE } from "../api.ts";
import { getReplicaBus, BusError } from "./replica-bus.ts";
import type { ReplicaStatus, WorkerEvent } from "./db-worker.ts";
import type { S3Config } from "../../core/sync/storage.ts";

/** Fired on `document` after a sync pulled remote changes; detail carries
 *  `{ datasets, rowIds }` so open views can refresh what they show. */
export const SYNCED_EVENT = "mh-synced";

const ENABLED_KEY = "mh_replica";
const HYDRATED_KEY = "mh_replica_hydrated";
const ORIGIN_MODE_KEY = "mh_origin_mode"; // "server" | "none"

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

// ---- origin mode: server-backed vs data-blind static shell host -------------
// The same bundle runs two ways: served by a metahub server (origin mode — pair
// + HTTP fallback, today's behavior) or from a data-blind static CDN (no-origin
// mode — bucket is the only data source). We auto-detect so nothing hardcodes a
// domain; the shell always works off its own self.location.origin.

type OriginMode = "server" | "none";
let originModeMemo: OriginMode | null = (() => {
  try {
    const v = localStorage.getItem(ORIGIN_MODE_KEY);
    return v === "server" || v === "none" ? v : null;
  } catch {
    return null;
  }
})();

/** Cached origin mode, or null until detectOriginMode() has run once. */
export function originMode(): OriginMode | null {
  return originModeMemo;
}
/** True when this shell has no metahub server behind it (bucket-only). */
export function isNoOrigin(): boolean {
  return originModeMemo === "none";
}

// ---- unified client mode (doc 19) ------------------------------------------
// The two orthogonal axes that used to be read as scattered isNoOrigin() /
// replicaActive() checks, collapsed into one object: where this client's
// canonical hub lives, and how this client holds data. New code (and, over time,
// the api/sw/app routing) should read this instead of re-deriving the axes.

export interface ClientMode {
  /** Where the hub this client talks to lives: a server (origin) vs this
   *  device's own local replica (no-origin, bucket-backed). */
  dataHome: "server" | "local";
  /** How this client holds data: a thin online "window" onto a server, or a
   *  full local "replica". A no-origin client is always a replica (a bucket
   *  can't be windowed); a server client is a window until offline-replica is on. */
  hold: "window" | "replica";
}

export function clientMode(): ClientMode {
  const noOrigin = isNoOrigin();
  return {
    dataHome: noOrigin ? "local" : "server",
    hold: noOrigin || replicaEnabled() ? "replica" : "window",
  };
}

/**
 * Detect whether this origin is a metahub server. /health returns {ok:true};
 * a static CDN returns 404 or — with SPA fallback — index.html, so we check the
 * parsed body, not the status. Cached so an offline reload keeps the mode
 * instead of misdetecting; a network error stays inconclusive (defaults server,
 * so an offline origin user never gets the enroll screen).
 */
export async function detectOriginMode(): Promise<OriginMode> {
  if (originModeMemo) return originModeMemo;
  try {
    const res = await fetch("/health", { cache: "no-store" });
    const d = res.ok ? ((await res.json().catch(() => null)) as { ok?: boolean } | null) : null;
    originModeMemo = d?.ok === true ? "server" : "none";
  } catch {
    return "server"; // inconclusive (offline) — don't cache, assume server
  }
  try {
    localStorage.setItem(ORIGIN_MODE_KEY, originModeMemo);
  } catch {
    /* private mode */
  }
  return originModeMemo;
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
  // Fire on both transitions: visible → pull fresh; hidden → force-flush pending
  // pushes before a possible suspension (storage batching defers small bursts).
  document.addEventListener("visibilitychange", requestSync);
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
  // Fire whenever the replica is running; the worker no-ops if there's no sync
  // target. (Previously gated on origin pairing, which excluded bucket-only
  // no-origin setups.) The worker's `sync` op force-flushes pending pushes.
  if (started) void call("sync").catch(() => {});
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

/**
 * No-origin onboarding: enroll a storage bucket as the data source when there's
 * no metahub server to pair with. Boots the replica, adds the bucket peer (which
 * fetches/creates the wrapped key and runs a first sync = hydration), and marks
 * the replica enabled so it resumes on the next load. Hydration progress streams
 * via status events; HYDRATED_KEY flips on the first successful sync.
 */
export async function enableReplicaFromBucket(
  config: S3Config,
  passphrase: string,
): Promise<{ url: string }> {
  startReplica();
  await waitReady();
  const r = await call<{ url: string }>("addStorageReplica", config, passphrase);
  setFlag(ENABLED_KEY, true);
  requestSync();
  return r;
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
