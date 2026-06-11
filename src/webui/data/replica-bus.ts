// Cross-tab transport for the browser replica. opfs-sahpool allows exactly one
// open connection per origin, so one tab must own the DB worker and every
// other tab proxies to it:
//
//   - Leadership: a Web Locks exclusive lock ("mh-replica-leader"). Whoever
//     acquires it spawns the worker and holds the lock until the tab dies; the
//     browser then hands the lock to the next tab, which spawns its own worker
//     (the dead tab's OPFS handles are released with it).
//   - Followers: RPC over a BroadcastChannel; the leader forwards to its
//     worker and replies. Worker events (status / synced) are rebroadcast on
//     the same channel so every tab sees them.
//
// Shared as a globalThis singleton (getReplicaBus) because two bundles can run
// in one page — the app bundle (replica.ts) and the injected /mh-runtime.js —
// and they must not race each other for the same tab's leadership.
//
// No imports from api.ts: this module is bundled into mh-runtime.js, which is
// injected into hosted site pages.

import type { RpcResponse, WorkerEvent } from "./db-worker.ts";

const CHANNEL = "mh-replica-bus";
const LOCK = "mh-replica-leader";
/** Follower RPC deadline. Generous: a fresh leader may still be booting wasm. */
const REMOTE_TIMEOUT_MS = 10_000;

type BusMsg =
  | { kind: "req"; id: string; op: string; args: unknown[] }
  | { kind: "res"; id: string; ok: boolean; result?: unknown; error?: { message: string; code?: string } }
  | { kind: "event"; event: WorkerEvent };

export class BusError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "BusError";
  }
}

export class ReplicaBus {
  private ch: BroadcastChannel | null = null;
  private worker: Worker | null = null;
  private started = false;
  leader = false;

  private nextLocal = 0;
  private localPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private remotePending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      // Kept so a request in flight when WE become the leader can be re-run
      // against our own worker — BroadcastChannel doesn't loop back to the
      // sender, so the broadcast would otherwise dangle until timeout (the
      // common case: a fresh tab calls before its lock grant callback fires).
      op: string;
      args: unknown[];
    }
  >();
  private listeners = new Set<(e: WorkerEvent) => void>();

  /** Join the bus: listen for events/replies and compete for leadership. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.ch = new BroadcastChannel(CHANNEL);
    this.ch.onmessage = (e: MessageEvent) => this.onChannel(e.data as BusMsg);
    const locks = (navigator as { locks?: LockManager }).locks;
    if (locks) {
      void locks
        .request(LOCK, () => {
          this.becomeLeader();
          return new Promise<void>(() => {}); // held until the tab dies
        })
        .catch(() => {});
    } else {
      // No Web Locks (ancient browser): act alone and hope for one tab.
      this.becomeLeader();
    }
  }

  onEvent(fn: (e: WorkerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  call<T>(op: string, ...args: unknown[]): Promise<T> {
    if (!this.started) this.start();
    if (this.leader) return this.workerCall<T>(op, args);
    return this.remoteCall<T>(op, args);
  }

  // ---- leader side -----------------------------------------------------------

  private becomeLeader(): void {
    if (this.leader) return;
    this.leader = true;
    this.spawnWorker();
    // Re-run requests we broadcast while still a follower: no one answered
    // (or will answer) now that the lock is ours.
    for (const [id, p] of [...this.remotePending]) {
      this.remotePending.delete(id);
      clearTimeout(p.timer);
      this.workerCall(p.op, p.args).then(p.resolve, p.reject);
    }
  }

  private spawnWorker(): void {
    if (this.worker) return;
    this.worker = new Worker("/db-worker.js", { type: "module" });
    this.worker.onmessage = (e: MessageEvent) => {
      const d = e.data as RpcResponse | WorkerEvent;
      if ("id" in d) {
        const p = this.localPending.get(d.id as number);
        if (!p) return;
        this.localPending.delete(d.id as number);
        if (d.ok) p.resolve(d.result);
        else p.reject(new BusError(d.error.message, d.error.code));
        return;
      }
      this.emit(d);
      this.ch?.postMessage({ kind: "event", event: d } satisfies BusMsg);
    };
    this.worker.onerror = () => {
      const evt: WorkerEvent = {
        event: "status",
        status: { state: "error", paired: false, node: null, error: "worker crashed" },
      };
      this.emit(evt);
      this.ch?.postMessage({ kind: "event", event: evt } satisfies BusMsg);
    };
  }

  private workerCall<T>(op: string, args: unknown[]): Promise<T> {
    if (!this.worker) this.spawnWorker(); // e.g. re-enable after stopWorker()
    const id = ++this.nextLocal;
    return new Promise<T>((resolve, reject) => {
      this.localPending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker!.postMessage({ id, op, args });
    });
  }

  // ---- follower side ----------------------------------------------------------

  private remoteCall<T>(op: string, args: unknown[]): Promise<T> {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.remotePending.delete(id);
        // Belt-and-braces for the follower→leader race: if leadership arrived
        // after becomeLeader() drained the map, run locally instead of failing.
        if (this.leader) {
          this.workerCall<T>(op, args).then(resolve as (v: T) => void, reject);
          return;
        }
        reject(new BusError("replica leader unavailable", "network"));
      }, REMOTE_TIMEOUT_MS);
      this.remotePending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, op, args });
      this.ch?.postMessage({ kind: "req", id, op, args } satisfies BusMsg);
    });
  }

  // ---- channel ----------------------------------------------------------------

  private onChannel(msg: BusMsg): void {
    if (msg.kind === "req") {
      if (!this.leader) return; // someone else's request; only the leader answers
      this.workerCall(msg.op, msg.args).then(
        (result) => this.ch?.postMessage({ kind: "res", id: msg.id, ok: true, result } satisfies BusMsg),
        (err: BusError) =>
          this.ch?.postMessage({
            kind: "res",
            id: msg.id,
            ok: false,
            error: { message: err.message, code: err.code },
          } satisfies BusMsg),
      );
      return;
    }
    if (msg.kind === "res") {
      const p = this.remotePending.get(msg.id);
      if (!p) return;
      this.remotePending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new BusError(msg.error?.message ?? "replica error", msg.error?.code));
      return;
    }
    if (msg.kind === "event" && !this.leader) this.emit(msg.event);
  }

  private emit(e: WorkerEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  /** Leader only: stop the worker (replica disabled / reset). The lock stays
   *  held so no other tab spawns a worker against half-wiped state. */
  stopWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.localPending.forEach((p) => p.reject(new BusError("replica stopped", undefined)));
    this.localPending.clear();
  }
}

/** Page-wide singleton across bundles (app bundle + injected mh-runtime.js). */
export function getReplicaBus(): ReplicaBus {
  const g = globalThis as { __mhReplicaBus?: ReplicaBus };
  return (g.__mhReplicaBus ??= new ReplicaBus());
}
