// Metahub data SDK for hosted site pages (and any same-origin caller).
// Served at /metahub-sdk.js; a site imports it as a module:
//
//   import { api } from "/metahub-sdk.js";
//   const rows = await api.listRecords("我的库");
//   await api.updateRecord(rows[0].id, { 状态: "完成" });
//
// This is OPTIONAL sugar over the public /api/* REST routes — plain
// fetch('/api/...') always works (the injected /mh-runtime.js attaches the
// token, and the service worker routes the call to the local replica when
// offline). The SDK adds typed methods, MhError-code-aware errors, and its own
// token attach/renew for contexts where the runtime isn't injected.
//
// Deliberately DOM-light (fetch + optional localStorage) and dependency-free.

import { initDrop, type DropClient } from "./drop.ts";

export interface SdkOptions {
  /** API origin; defaults to same-origin (hosted pages). */
  baseUrl?: string;
  /** Explicit Bearer token; defaults to the browser's stored one. */
  token?: string;
  /** Password for the sealed write-drop fallback, when the site's grant set one. */
  dropPassword?: string;
}

/** Carries the server's error `code` (core/errors.ts) so callers dispatch on
 *  it ("stale" → re-read, "not_found" → vanish) instead of message text. */
export class MetahubError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number,
  ) {
    super(message);
    this.name = "MetahubError";
  }
}

const TOKEN_KEY = "mh_token";
const RENEW_PATH = "/auth/token";

/**
 * The API base for the current mount. One page runs unchanged under all four
 * mounts because its data calls stay relative to where it is served:
 *   /sites/<name>/…  →  "/sites/<name>"  (owner: full API; public: grant-scoped)
 *   /share/<slug>/…  →  "/share/<slug>"  (grant-scoped, session-gated)
 *   /r/<slug>/…      →  "/r/<slug>"      (Durable Object room — grant-scoped + live WS pokes)
 *   anywhere else    →  ""               (the root /api/*)
 * `pathname` is injectable for tests / non-DOM contexts.
 */
export function detectBase(pathname?: string): string {
  const p =
    pathname ?? (typeof location !== "undefined" && location ? location.pathname : "");
  const m = /^\/(sites|share|r)\/[^/]+/.exec(p);
  return m ? m[0] : "";
}

export function createClient(opts: SdkOptions = {}) {
  const base = (opts.baseUrl ?? detectBase()).replace(/\/$/, "");
  // Token renewal is a ROOT endpoint — it is not mounted under /sites|/share.
  // A relative base (site/share mount, same origin) renews at the origin root;
  // an absolute base renews at that base's origin.
  const renewUrl = /^https?:\/\//i.test(base)
    ? new URL(RENEW_PATH, base).toString()
    : RENEW_PATH;

  const storedToken = (): string | null => {
    if (opts.token) return opts.token;
    try {
      return typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
    } catch {
      return null;
    }
  };

  const saveToken = (t: string): void => {
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch {
      /* not persistable here */
    }
  };

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const exec = (token: string | null): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (token) headers["authorization"] = `Bearer ${token}`;
      return fetch(base + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    };

    let token = storedToken();
    let res = await exec(token);
    // Transparent renewal: an in-grace token swaps itself for the current one.
    if (res.status === 401 && token && !opts.token) {
      const renewed = await fetch(renewUrl, {
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => null);
      const d = renewed?.ok ? ((await renewed.json()) as { token?: string }) : null;
      if (d?.token) {
        saveToken(d.token);
        token = d.token;
        res = await exec(token);
      }
    }

    const data = (await res.json().catch(() => null)) as
      | ({ error?: string; code?: string } & T)
      | null;
    if (!res.ok || (data && data.error)) {
      throw new MetahubError(
        data?.error ?? `${res.status} ${res.statusText}`,
        data?.code,
        res.status,
      );
    }
    return data as T;
  }

  const q = (s: string) => encodeURIComponent(s);

  // Sealed write-drop fallback (async public writes): when the realtime
  // endpoint refuses (401 — no write grant on this mount, or the server is
  // auth-gated) or the network fails outright, and the page ships an
  // mh-drop.json (published by `mh site grant … <db>:create` auto-wiring),
  // createRecord degrades to sealing the write to the owner's key and posting
  // it to the inbox host. Site authors keep writing plain api.createRecord();
  // the returned record carries `_pending: true` (see drop.ts optimistic echo).
  let dropClient: Promise<DropClient | null> | null = null;
  const dropFallback = (): Promise<DropClient | null> => {
    dropClient ??= initDrop(`${base}/mh-drop.json`, { password: opts.dropPassword }).catch(
      () => null,
    );
    return dropClient;
  };

  return {
    // databases
    listDatabases: () => req<DbInfo[]>("GET", "/api/databases"),
    createDatabase: (b: { name: string; icon?: string }) => req<DbInfo>("POST", "/api/databases", b),

    // properties (columns)
    listProperties: (db: string) => req<PropInfo[]>("GET", `/api/properties?db=${q(db)}`),

    // records
    listRecords: (db: string, opts2: { sort?: string; limit?: number } = {}) => {
      const p = new URLSearchParams({ db });
      if (opts2.sort) p.set("sort", opts2.sort);
      if (opts2.limit != null) p.set("limit", String(opts2.limit));
      return req<RecordInfo[]>("GET", `/api/records?${p}`);
    },
    getRecord: (id: string) => req<RecordInfo>("GET", `/api/record?id=${q(id)}`),
    createRecord: async (db: string, values: Record<string, unknown>): Promise<RecordInfo> => {
      try {
        return await req<RecordInfo>("POST", `/api/records?db=${q(db)}`, values);
      } catch (e) {
        // Only auth refusals and transport failures may fall back — a 400/404/429
        // is a real answer from a reachable, willing endpoint.
        const eligible = e instanceof MetahubError ? e.status === 401 : true;
        if (!eligible) throw e;
        const drop = await dropFallback();
        if (!drop) throw e;
        return (await drop.createRecord(db, values)) as unknown as RecordInfo;
      }
    },
    updateRecord: (id: string, values: Record<string, unknown>) =>
      req<RecordInfo>("PATCH", `/api/record?id=${q(id)}`, values),
    deleteRecord: (id: string) => req<{ ok: boolean }>("DELETE", `/api/record?id=${q(id)}`),

    // documents
    listDocuments: (db?: string) =>
      req<DocSummaryInfo[]>("GET", db ? `/api/documents?db=${q(db)}` : "/api/documents"),
    getDocument: (id: string) => req<DocInfo>("GET", `/api/document?id=${q(id)}`),
    createDocument: (b: { title: string; body?: string; database_id?: string; parent_id?: string }) =>
      req<DocInfo>("POST", "/api/documents", b),
    updateDocument: (
      id: string,
      b: { title?: string; body?: string; parent_id?: string | null; if_match?: string },
    ) => req<DocInfo>("PATCH", `/api/document?id=${q(id)}`, b),
    deleteDocument: (id: string) => req<{ ok: boolean }>("DELETE", `/api/document?id=${q(id)}`),

    // search
    search: (text: string, limit?: number) => {
      const p = new URLSearchParams({ q: text });
      if (limit != null) p.set("limit", String(limit));
      return req<SearchHitInfo[]>("GET", `/api/search?${p}`);
    },

    /**
     * Live-update notifications. On a room mount (/r/<slug>/) this opens a
     * WebSocket to the room and invokes `cb` on every data poke (owner sync,
     * another guest's write) — refetch what you render. Auto-reconnects until
     * unsubscribed. On every other mount there is no push channel; pass
     * `pollMs` to degrade to a simple interval callback (off by default).
     * Returns an unsubscribe function.
     */
    onUpdate(cb: (info: { seq?: number }) => void, opts: { pollMs?: number } = {}): () => void {
      let stopped = false;
      let ws: WebSocket | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const roomBase = /(^|\/)r\/[^/]+$/.test(base) ? base : null;
      if (roomBase && typeof WebSocket !== "undefined") {
        // Same-origin relative base ("/r/<slug>") resolves against location;
        // an absolute baseUrl resolves against itself. http(s) → ws(s).
        const abs = /^https?:\/\//i.test(roomBase)
          ? new URL(roomBase + "/ws")
          : new URL(roomBase + "/ws", typeof location !== "undefined" ? location.href : "http://localhost");
        abs.protocol = abs.protocol === "https:" ? "wss:" : "ws:";
        // Exponential backoff with jitter (1s → 30s cap), reset on a healthy
        // open. A close code in the app-auth range (4401/4403 — session expired,
        // grant revoked, room deleted) is terminal: stop reconnecting instead of
        // hammering a door that will never open (the old code retried a dead room
        // every 3s for the tab's lifetime, draining battery and flooding logs).
        let attempt = 0;
        const AUTH_CLOSE = new Set([1008, 4401, 4403]);
        const connect = (): void => {
          if (stopped) return;
          ws = new WebSocket(abs.toString());
          ws.onopen = () => {
            attempt = 0; // healthy connection — reset the backoff
          };
          ws.onmessage = (ev) => {
            try {
              const d = JSON.parse(String(ev.data)) as { type?: string; seq?: number };
              if (d?.type === "poke") cb({ seq: d.seq });
            } catch {
              /* non-JSON frame (e.g. pong) — ignore */
            }
          };
          ws.onerror = () => {
            /* surfaced as a close; reconnection is handled there */
          };
          ws.onclose = (ev) => {
            if (stopped || AUTH_CLOSE.has(ev.code)) {
              stopped = true;
              return;
            }
            const backoff = Math.min(30000, 1000 * 2 ** attempt++);
            const jitter = backoff * 0.25 * Math.random(); // spread reconnects across tabs
            timer = setTimeout(connect, backoff + jitter);
          };
        };
        connect();
      } else if (opts.pollMs && opts.pollMs > 0) {
        const iv = setInterval(() => cb({}), opts.pollMs);
        timer = iv as unknown as ReturnType<typeof setTimeout>;
      }

      return () => {
        stopped = true;
        if (timer != null) {
          clearTimeout(timer);
          clearInterval(timer as unknown as ReturnType<typeof setInterval>);
        }
        try {
          ws?.close();
        } catch {
          /* already closed */
        }
      };
    },
  };
}

// ---- shapes (mirrors src/webui/server/routes.ts responses) -------------------------

export interface DbInfo {
  id: string;
  name: string;
  icon: string | null;
  created_hlc?: string;
}
export interface PropInfo {
  id: string;
  database_id: string;
  name: string;
  type: string;
  config: Record<string, unknown> | null;
  position: number;
}
export interface RecordInfo {
  id: string;
  database_id: string;
  /** Cells keyed by property name (lossy under duplicate names). */
  values: Record<string, unknown>;
  /** Cells keyed by property id (duplicate-name safe). */
  cells: Record<string, unknown>;
}
export interface DocSummaryInfo {
  id: string;
  title: string;
  database_id: string | null;
  parent_id: string | null;
}
export interface DocInfo extends DocSummaryInfo {
  body: string | null;
  /** Echo back as if_match on update to detect concurrent edits (HTTP mode). */
  version?: string;
}
export interface SearchHitInfo {
  type: string;
  id: string;
  database_id: string | null;
  title?: string;
  snippet: string;
}

// Sealed write-drop client (async public submissions) — exported for pages
// that want the optimistic-echo helpers (pending/merge) or Turnstile/password
// wiring; api.createRecord auto-routes through it when the realtime endpoint
// is unavailable.
export { initDrop, createDrop } from "./drop.ts";
export type { DropClient, DropConfig, PendingRecord } from "./drop.ts";

/** Ready-to-use same-origin client — what hosted site pages want. */
export const api = createClient();
