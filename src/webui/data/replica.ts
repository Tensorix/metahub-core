// Main-thread client for the browser replica: app-facing status store, the
// enable/disable (pair/unpair) flows, DOM event fan-out, and the service
// worker bridge. Transport — who owns the DB worker, cross-tab proxying — is
// ReplicaBus (replica-bus.ts): this tab is either the leader (direct worker)
// or a follower (BroadcastChannel to the leader), decided by a Web Lock.
// The decision of WHEN to route reads/writes locally lives in local-api.ts.

import { authFetch, NAV_INVALIDATE } from "../api.ts";
import { getReplicaBus, BusError } from "./replica-bus.ts";
import { probeOrigin, type OriginMode } from "./origin.ts";
import type { ReplicaStatus, WorkerEvent } from "./db-worker.ts";
import type { S3Config } from "../../core/sync/storage.ts";

/** Fired on `document` after a sync pulled remote changes; detail carries
 *  `{ datasets, rowIds }` so open views can refresh what they show. */
export const SYNCED_EVENT = "mh-synced";
export const REPLICA_LIFECYCLE_EVENT = "mh-replica-lifecycle";
export type ReplicaLifecycle = "enabled" | "disabled" | "reset";

function notifyReplicaLifecycle(state: ReplicaLifecycle): void {
  if (typeof document !== "undefined")
    document.dispatchEvent(
      new CustomEvent<ReplicaLifecycle>(REPLICA_LIFECYCLE_EVENT, { detail: state }),
    );
}

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
 *  empty (or stale-partial) hub, which is worse than staying online.
 *  @internal A raw axis kept for the api/sw/app routing not yet migrated; new
 *  feature code should read clientMode()/scopesFor() rather than this flag. */
export function replicaActive(): boolean {
  return replicaEnabled() && flag(HYDRATED_KEY) && started && status.state !== "error";
}

// ---- origin mode: server-backed vs data-blind static shell host -------------
// The same bundle runs two ways: served by a metahub server (origin mode — pair
// + HTTP fallback, today's behavior) or from a data-blind static CDN (no-origin
// mode — bucket is the only data source). We auto-detect so nothing hardcodes a
// domain; the shell always works off its own self.location.origin.

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
/** True when this shell has no metahub server behind it (bucket-only).
 *  @internal A raw axis. New feature code should read clientMode()/scopesFor()
 *  instead of branching on this directly — a single isNoOrigin() fork can't name
 *  the server+replica cell and that's exactly how multi-end cases get missed. */
export function isNoOrigin(): boolean {
  return originModeMemo === "none";
}

// ---- unified client mode (doc 19) ------------------------------------------
// The two orthogonal axes that used to be read as scattered isNoOrigin() /
// replicaActive() checks, collapsed into one object: where this client's
// canonical hub lives, and how this client holds data. New code (and, over time,
// the api/sw/app routing) should read this instead of re-deriving the axes.

/** Which host process this client runs in — a third axis orthogonal to
 *  dataHome/hold. "desktop" is the Electron renderer over a localhost sidecar
 *  (the sidecar IS the data home, no separate OPFS copy); "cli" is reserved so
 *  scopesFor() stays total (the CLI never renders UI). Replaces scattered
 *  window.metahubDesktop sniffing as call sites migrate to clientMode(). */
export type Surface = "web" | "desktop" | "cli";

export interface ClientMode {
  /** Which host process renders this client (browser tab vs desktop sidecar). */
  surface: Surface;
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
    surface: typeof window !== "undefined" && window.metahubDesktop ? "desktop" : "web",
    dataHome: noOrigin ? "local" : "server",
    hold: noOrigin || replicaEnabled() ? "replica" : "window",
  };
}

/**
 * Detect whether this origin is a metahub server. /health returns {ok:true};
 * a static CDN returns 404 or — with SPA fallback — index.html, so we check the
 * parsed body, not the status (see classifyOrigin). Only a definitive verdict is
 * cached; anything inconclusive — offline, a network error, or a transient 5xx
 * from a deploying server — defaults to server and is NOT cached, so a brief
 * deploy-window 502 can't lock a first-visit user onto the enroll screen.
 */
export async function detectOriginMode(): Promise<OriginMode> {
  if (originModeMemo) return originModeMemo;
  const mode = await probeOrigin();
  if (mode === "unknown") return "server"; // inconclusive — assume server, don't cache → re-probe next load
  originModeMemo = mode;
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

export function syncReplicaNow(): Promise<ReplicaStatus["lastSync"]> {
  if (!started) return Promise.reject(new ReplicaError("replica not running", undefined));
  return call<ReplicaStatus["lastSync"]>("sync");
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
export async function enableReplicaFromServer(): Promise<void> {
  if (isNoOrigin())
    throw new ReplicaError(
      "此页面没有工作区主节点，不能使用服务器配对；请重新连接同步存储桶。",
      "invalid_input",
    );
  startReplica();
  await waitReady();
  if (!status.paired) {
    const res = await authFetch("/api/pair/new", { method: "POST" });
    if (!res.ok) throw new ReplicaError(`无法获取配对码: ${res.status}`, undefined);
    const { code } = (await res.json()) as { code: string };
    await call("pair", code);
  }
  setFlag(ENABLED_KEY, true);
  ensurePwaRegistration(); // now a replica → register the SW live (no reload needed)
  requestSync();
  notifyReplicaLifecycle("enabled");
}

/** @deprecated Use the topology-explicit enableReplicaFromServer. */
export const enableReplica = enableReplicaFromServer;

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
  ensurePwaRegistration(); // now a replica → register the SW live (no reload needed)
  requestSync();
  notifyReplicaLifecycle("enabled");
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
  // Lightweight window keeps no SW: drop the offline gateway + shell/api caches so
  // it stops intercepting /api/* (the offline ERR_CONNECTION_REFUSED source).
  await teardownPwa();
  notifyReplicaLifecycle("disabled");
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
    await teardownPwa(); // full wipe → also drop the SW + shell/api caches
    // Drop the stale "ready" status and the started flag so a later
    // enableReplica() re-runs the full join (startReplica → fresh worker) and
    // waitReady() actually waits for that worker, instead of resolving on this
    // run's leftover "ready". startReplica is re-entrant: its side effects
    // (bus.onEvent's Set, the same-ref window/document listeners, the globally
    // guarded SW bridge) all dedupe. Settings UI repaints off the status event.
    started = false;
    status = { state: "booting", paired: false, node: null };
    for (const fn of statusListeners) fn(status);
    notifyReplicaLifecycle("reset");
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

// ---- PWA (service worker) lifecycle -------------------------------------------
// Only a replica-holding client (trusted device, or a no-origin bucket-only home)
// has any use for the SW: it's the offline shell + the /api offline gateway. A
// lightweight online-only window must NOT keep one — a leftover SW from a prior
// trusted session keeps intercepting /api/*, forwards to a now-unreachable origin,
// and surfaces a raw net::ERR_CONNECTION_REFUSED offline. So registration is gated
// on clientMode().hold, and switching to lightweight actively tears the SW down.

let pwaWired = false;

/** Unregister the service worker and drop its shell/api/blob caches. The bridge
 *  message listener (installSwBridge) is intentionally left in place: it's inert
 *  with no SW to message, idempotent on a later re-enable, and was added as an
 *  anonymous handler that can't be removeEventListener'd anyway. The wasm cache
 *  is kept so re-enabling a trusted device doesn't re-download ~1MB. The blob
 *  spool (IndexedDB) is left untouched so offline-composed images still pending
 *  upload aren't lost on a downgrade to lightweight. */
export async function teardownPwa(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
    }
  } catch {
    /* unsupported / insecure context — nothing to tear down */
  }
  try {
    if ("caches" in globalThis) {
      for (const key of await caches.keys()) {
        if (key.startsWith("mh-shell-") || key === "mh-api-v1" || key === "mh-blob-v1")
          await caches.delete(key);
      }
    }
  } catch {
    /* CacheStorage unavailable — best effort */
  }
}

/** Reconcile the SW with this client's mode. A replica registers /sw.js (and
 *  wires a one-shot auto-reload when a new version takes control); a lightweight
 *  window tears any leftover SW down. Idempotent — safe to call on every boot and
 *  on each enable/disable. */
export function ensurePwaRegistration(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (typeof window === "undefined" || !window.isSecureContext) return;
  // Desktop renderer is a pure window onto the local sidecar (its data home), so
  // it never needs the SW — and a stale mh_replica flag must not make it register
  // one. Legacy registrations span random-port origins and are cleaned once by
  // the Electron main process; touching navigator.serviceWorker here would open
  // that profile database again and can repeat Chromium's Database IO warning.
  const mode = clientMode();
  if (mode.surface === "desktop") return;
  if (mode.hold !== "replica") {
    void teardownPwa(); // lightweight browser window → self-heal a stale SW
    return;
  }
  navigator.serviceWorker.register("/sw.js").catch((e) => {
    // Progressive enhancement — never block the app — but warn: a silent failure
    // here silently costs offline support.
    console.warn("[webui] service worker registration failed —", e);
  });
  if (pwaWired) return;
  pwaWired = true;
  // Auto-reload once when a *new* SW version takes control, so a long-lived tab
  // never keeps running a bundle behind the active worker. The first claim of a
  // fresh install (page loaded uncontrolled) is skipped; only later updates reload.
  let controlled = navigator.serviceWorker.controller != null;
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
}
