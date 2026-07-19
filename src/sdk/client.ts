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

import {
  createDrop,
  deriveDropPasswordVerifier,
  initDrop,
  type DropClient,
  type DropConfig,
  type PendingRecord,
} from "./drop.ts";

export interface SdkOptions {
  /** API origin; defaults to same-origin (hosted pages). */
  baseUrl?: string;
  /** Explicit Bearer token; defaults to the browser's stored one. */
  token?: string;
  /** Password for the sealed write-drop fallback, when the site's grant set one. */
  dropPassword?: string;
  /** Override deployment-manifest discovery. Useful for a static site whose
   *  explicit baseUrl is not itself a /sites|/share|/r mount. */
  manifestUrl?: string;
}

export interface WriteOptions {
  /** Cloudflare Turnstile proof for a write-gated public site. */
  turnstileToken?: string;
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

/** The owner-published deployment manifest (mh-manifest.json) — the SDK's
 *  explicit channel map (see core/sync/drop-wire.ts buildManifest). */
export interface DeploymentManifest {
  v: 1;
  mode: "live" | "static-async";
  runtimeEndpoint?: string;
  websocketEndpoint?: string;
  inboxEndpoint?: string;
  fallback?: "inbox";
  policyRevision: number;
  drop?: Omit<DropConfig, "v" | "endpoint">;
}

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

function isGuestMountBase(base: string): boolean {
  let path = base;
  if (/^https?:\/\//i.test(base)) {
    try {
      path = new URL(base).pathname.replace(/\/+$/, "");
    } catch {
      return false;
    }
  }
  return /^\/(sites|share|r)\/[^/]+$/.test(path);
}

function isDropDatabaseInfo(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const db = value as { id?: unknown; name?: unknown; properties?: unknown };
  return (
    typeof db.id === "string" &&
    db.id.length > 0 &&
    typeof db.name === "string" &&
    db.name.length > 0 &&
    Array.isArray(db.properties) &&
    db.properties.every((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const prop = value as { id?: unknown; name?: unknown; type?: unknown };
      return (
        typeof prop.id === "string" &&
        prop.id.length > 0 &&
        typeof prop.name === "string" &&
        prop.name.length > 0 &&
        typeof prop.type === "string" &&
        prop.type.length > 0
      );
    })
  );
}

function parseManifest(raw: unknown): DeploymentManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new MetahubError("malformed mh-manifest.json", "invalid_input", 500);
  const m = raw as Partial<DeploymentManifest>;
  if (
    m.v !== 1 ||
    (m.mode !== "live" && m.mode !== "static-async") ||
    !Number.isInteger(m.policyRevision) ||
    (m.policyRevision as number) < 0 ||
    (m.runtimeEndpoint !== undefined && typeof m.runtimeEndpoint !== "string") ||
    (m.websocketEndpoint !== undefined && typeof m.websocketEndpoint !== "string") ||
    (m.inboxEndpoint !== undefined && typeof m.inboxEndpoint !== "string") ||
    (m.fallback !== undefined && m.fallback !== "inbox")
  )
    throw new MetahubError("malformed mh-manifest.json", "invalid_input", 500);

  if (m.drop !== undefined) {
    const d = m.drop as Partial<DropConfig>;
    if (
      !d ||
      typeof d !== "object" ||
      typeof d.drop_id !== "string" ||
      !d.drop_id ||
      typeof d.key_id !== "string" ||
      !d.key_id ||
      typeof d.pk !== "string" ||
      !d.pk ||
      (d.payload_versions !== undefined &&
        (!Array.isArray(d.payload_versions) ||
          !d.payload_versions.every((v) => Number.isInteger(v) && v > 0))) ||
      (d.databases !== undefined &&
        (!Array.isArray(d.databases) || !d.databases.every(isDropDatabaseInfo))) ||
      (d.password_salt !== undefined &&
        (typeof d.password_salt !== "string" || !d.password_salt)) ||
      (d.turnstile_sitekey !== undefined &&
        (typeof d.turnstile_sitekey !== "string" || !d.turnstile_sitekey))
    )
      throw new MetahubError("malformed mh-manifest.json drop config", "invalid_input", 500);
  }
  if (
    (m.mode === "static-async" || m.fallback === "inbox") &&
    (!m.inboxEndpoint || !m.drop)
  )
    throw new MetahubError("inbox deployment is missing endpoint or drop config", "invalid_input", 500);
  return m as DeploymentManifest;
}

function resolveEndpoint(endpoint: string | undefined, fallback: string): string {
  if (!endpoint) return fallback;
  if (/^https?:\/\//i.test(endpoint)) return endpoint.replace(/\/+$/, "");
  if (/^https?:\/\//i.test(fallback)) {
    return new URL(endpoint, fallback.endsWith("/") ? fallback : fallback + "/")
      .toString()
      .replace(/\/+$/, "");
  }
  if (endpoint.startsWith("/")) return endpoint.replace(/\/+$/, "");
  return `${fallback}/${endpoint}`.replace(/\/+/g, "/").replace(/\/+$/, "");
}

export function createClient(opts: SdkOptions = {}) {
  const base = (opts.baseUrl ?? detectBase()).replace(/\/$/, "");
  const pathMounted = isGuestMountBase(base);
  const discoverManifest =
    opts.manifestUrl !== undefined || opts.baseUrl === undefined || pathMounted;
  const manifestUrl = opts.manifestUrl ?? `${base}/mh-manifest.json`;
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

  async function reqAt<T>(
    endpoint: string,
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const exec = (token: string | null): Promise<Response> => {
      const headers: Record<string, string> = { ...extraHeaders };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (token) headers["authorization"] = `Bearer ${token}`;
      return fetch(endpoint + path, {
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

  let manifestP: Promise<DeploymentManifest | null> | null = null;
  const getManifest = (): Promise<DeploymentManifest | null> => {
    if (!discoverManifest) return Promise.resolve(null);
    manifestP ??= (async () => {
      let res: Response;
      try {
        res = await fetch(manifestUrl);
      } catch (e) {
        throw new MetahubError(
          `deployment manifest unavailable: ${(e as Error).message}`,
          "network",
          0,
        );
      }
      if (res.status === 404) return null;
      if (!res.ok)
        throw new MetahubError(
          `deployment manifest failed (HTTP ${res.status})`,
          "network",
          res.status,
        );
      return parseManifest(await res.json().catch(() => null));
    })();
    return manifestP;
  };

  const liveEndpoint = (manifest: DeploymentManifest | null): string => {
    if (manifest?.mode === "static-async")
      throw new MetahubError("static-async deployment has no live runtime", "invalid_input", 400);
    return resolveEndpoint(manifest?.runtimeEndpoint, base);
  };

  const dataReq = async <T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> => {
    const manifest = await getManifest();
    return reqAt<T>(liveEndpoint(manifest), method, path, body, headers);
  };

  const q = (s: string) => encodeURIComponent(s);

  // A client idempotency key for a guest write intent — random enough that a
  // retried submission reuses the SAME id (the caller retries the same request),
  // while two distinct writes never collide.
  const newIntentId = (): string =>
    "int_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  // Sealed write-drop: manifest deployments use the embedded config; only
  // legacy/no-manifest sites discover mh-drop.json.
  let dropClient: Promise<DropClient | null> | null = null;
  const dropFor = (manifest: DeploymentManifest | null): Promise<DropClient | null> => {
    dropClient ??= (
      manifest?.drop && manifest.inboxEndpoint
        ? Promise.resolve(
            createDrop(
              {
                ...manifest.drop,
                v: 1,
                endpoint: manifest.inboxEndpoint,
              },
              { password: opts.dropPassword },
            ),
          )
        : initDrop(`${base}/mh-drop.json`, { password: opts.dropPassword })
    ).catch(() => null);
    return dropClient;
  };

  let passwordProofP: Promise<string | null> | null = null;
  const liveWriteHeaders = async (
    manifest: DeploymentManifest | null,
    writeOpts: WriteOptions,
  ): Promise<Record<string, string>> => {
    const headers: Record<string, string> = {};
    if (writeOpts.turnstileToken)
      headers["x-turnstile-token"] = writeOpts.turnstileToken;
    const salt = manifest?.drop?.password_salt;
    if (opts.dropPassword && salt) {
      passwordProofP ??= deriveDropPasswordVerifier(opts.dropPassword, salt);
      headers["x-drop-pass"] = await passwordProofP;
    }
    return headers;
  };

  return {
    // databases
    listDatabases: () => dataReq<DbInfo[]>("GET", "/api/databases"),
    createDatabase: (b: { name: string; icon?: string }) =>
      dataReq<DbInfo>("POST", "/api/databases", b),

    // properties (columns)
    listProperties: (db: string) => dataReq<PropInfo[]>("GET", `/api/properties?db=${q(db)}`),

    // records
    listRecords: (db: string, opts2: { sort?: string; limit?: number } = {}) => {
      const p = new URLSearchParams({ db });
      if (opts2.sort) p.set("sort", opts2.sort);
      if (opts2.limit != null) p.set("limit", String(opts2.limit));
      return dataReq<RecordInfo[]>("GET", `/api/records?${p}`);
    },
    getRecord: (id: string) => dataReq<RecordInfo>("GET", `/api/record?id=${q(id)}`),
    createRecord: async (
      db: string,
      values: Record<string, unknown>,
      writeOpts: WriteOptions = {},
    ): Promise<RecordInfo | PendingRecord> => {
      const manifest = await getManifest();
      if (manifest?.mode === "static-async") {
        const drop = await dropFor(manifest);
        if (!drop)
          throw new MetahubError("static-async inbox is unavailable", "network", 0);
        return drop.createRecord(db, values, writeOpts);
      }
      // On a guest mount, send the idempotent intent wrapper so a retried POST
      // (dropped response) can't double-create. The root main API doesn't parse
      // wrappers, so only wrap on a mount; and if a mount server is older than
      // this SDK (a vendored copy), retry once with the plain body.
      const endpoint = liveEndpoint(manifest);
      const mounted = isGuestMountBase(endpoint);
      const body = mounted ? { $intent: { id: newIntentId(), submittedAt: Date.now() }, values } : values;
      const headers = await liveWriteHeaders(manifest, writeOpts);
      try {
        return await reqAt<RecordInfo>(
          endpoint,
          "POST",
          `/api/records?db=${q(db)}`,
          body,
          headers,
        );
      } catch (e) {
        if (
          mounted &&
          e instanceof MetahubError &&
          (e.status === 400 || e.status === 404)
        ) {
          try {
            return await reqAt<RecordInfo>(
              endpoint,
              "POST",
              `/api/records?db=${q(db)}`,
              values,
              headers,
            );
          } catch (e2) {
            e = e2;
          }
        }
        // Only auth refusals and transport failures may fall back — a 400/404/429
        // is a real answer from a reachable, willing endpoint.
        const eligible = e instanceof MetahubError ? e.status === 401 : true;
        if (!eligible) throw e;
        // New deployments degrade only when the manifest explicitly opts in.
        // No-manifest sites keep the legacy mh-drop.json behavior.
        if (manifest && manifest.fallback !== "inbox") throw e;
        const drop = await dropFor(manifest);
        if (!drop) throw e;
        return drop.createRecord(db, values, writeOpts);
      }
    },
    updateRecord: async (
      id: string,
      values: Record<string, unknown>,
      writeOpts: WriteOptions = {},
    ): Promise<RecordInfo> => {
      const manifest = await getManifest();
      if (manifest?.mode === "static-async")
        throw new MetahubError(
          "static-async deployment does not support updateRecord",
          "invalid_input",
          400,
        );
      const endpoint = liveEndpoint(manifest);
      const mounted = isGuestMountBase(endpoint);
      const body = mounted ? { $intent: { id: newIntentId(), submittedAt: Date.now() }, values } : values;
      const headers = await liveWriteHeaders(manifest, writeOpts);
      try {
        return await reqAt<RecordInfo>(
          endpoint,
          "PATCH",
          `/api/record?id=${q(id)}`,
          body,
          headers,
        );
      } catch (e) {
        if (
          mounted &&
          e instanceof MetahubError &&
          (e.status === 400 || e.status === 404)
        )
          return reqAt<RecordInfo>(
            endpoint,
            "PATCH",
            `/api/record?id=${q(id)}`,
            values,
            headers,
          );
        throw e;
      }
    },
    deleteRecord: async (id: string) => {
      const manifest = await getManifest();
      if (manifest?.mode === "static-async")
        throw new MetahubError(
          "static-async deployment does not support deleteRecord",
          "invalid_input",
          400,
        );
      return reqAt<{ ok: boolean }>(
        liveEndpoint(manifest),
        "DELETE",
        `/api/record?id=${q(id)}`,
      );
    },

    // documents
    listDocuments: (db?: string) =>
      dataReq<DocSummaryInfo[]>("GET", db ? `/api/documents?db=${q(db)}` : "/api/documents"),
    getDocument: (id: string) => dataReq<DocInfo>("GET", `/api/document?id=${q(id)}`),
    createDocument: (b: { title: string; body?: string; database_id?: string; parent_id?: string }) =>
      dataReq<DocInfo>("POST", "/api/documents", b),
    updateDocument: (
      id: string,
      b: { title?: string; body?: string; parent_id?: string | null; if_match?: string },
    ) => dataReq<DocInfo>("PATCH", `/api/document?id=${q(id)}`, b),
    deleteDocument: (id: string) =>
      dataReq<{ ok: boolean }>("DELETE", `/api/document?id=${q(id)}`),

    // search
    search: (text: string, limit?: number) => {
      const p = new URLSearchParams({ q: text });
      if (limit != null) p.set("limit", String(limit));
      return dataReq<SearchHitInfo[]>("GET", `/api/search?${p}`);
    },

    /**
     * Live-update notifications. On a room mount (/r/<slug>/) this opens a
     * WebSocket to the room and invokes `cb` on every data poke (owner sync,
     * another guest's write) — refetch what you render. Auto-reconnects until
     * unsubscribed; when the room turns out to be permanently gone (deleted /
     * expired / revoked) the subscription stops and `cb({gone: true})` fires
     * once — re-subscribing requires a new onUpdate call. On every other mount
     * there is no push channel; pass `pollMs` to degrade to a simple interval
     * callback (off by default). Returns an unsubscribe function.
     */
    onUpdate(cb: (info: { seq?: number; gone?: true }) => void, opts: { pollMs?: number } = {}): () => void {
      let stopped = false;
      let ws: WebSocket | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let stableTimer: ReturnType<typeof setTimeout> | null = null;

      const roomBase = /(^|\/)r\/[^/]+$/.test(base) ? base : null;
      if (roomBase && typeof WebSocket !== "undefined") {
        // Same-origin relative base ("/r/<slug>") resolves against location;
        // an absolute baseUrl resolves against itself. http(s) → ws(s).
        const abs = /^https?:\/\//i.test(roomBase)
          ? new URL(roomBase + "/ws")
          : new URL(roomBase + "/ws", typeof location !== "undefined" ? location.href : "http://localhost");
        // http(s) form of the SAME path, captured BEFORE the ws swap: the room
        // liveness probe. A live room answers a plain GET /ws with 426 (both
        // the Bun server and the DO); a deleted/expired/revoked one answers a
        // bare 404 — the ONLY reliable "gone forever" signal (the server
        // rejects a dead room's upgrade with HTTP 404, which a browser
        // surfaces as close code 1006, indistinguishable from a network blip).
        const probeUrl = abs.toString();
        abs.protocol = abs.protocol === "https:" ? "wss:" : "ws:";
        // Exponential backoff with jitter (1s → 30s cap). `attempt` resets only
        // after ~5s of PROVEN stability, not on open — an endpoint that accepts
        // the upgrade and immediately drops would otherwise reset the backoff
        // every cycle into a permanent 1s hammer. Close codes 4401/4403 are
        // reserved app-auth codes (terminal if the server ever adopts them);
        // 1008 is deliberately NOT terminal — intermediaries send it for
        // transient policy reasons unrelated to auth.
        let attempt = 0;
        const AUTH_CLOSE = new Set([4401, 4403]);
        const terminate = (): void => {
          stopped = true;
          cb({ gone: true });
        };
        const connect = (): void => {
          if (stopped) return;
          let opened = false;
          ws = new WebSocket(abs.toString());
          ws.onopen = () => {
            opened = true;
            stableTimer = setTimeout(() => {
              attempt = 0; // survived 5s — a genuinely healthy connection
            }, 5000);
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
            if (stableTimer != null) {
              clearTimeout(stableTimer); // closed before proving stability
              stableTimer = null;
            }
            if (stopped) return;
            if (AUTH_CLOSE.has(ev.code)) {
              terminate();
              return;
            }
            const backoff = Math.min(30000, 1000 * 2 ** attempt++);
            const jitter = backoff * 0.25 * Math.random(); // spread reconnects across tabs
            const retry = (): void => {
              timer = setTimeout(connect, backoff + jitter);
            };
            // 3+ dials in a row never even opened: distinguish "room gone"
            // from a transient outage before backing off again. Only a clean
            // 404 is terminal; 426 (alive), other statuses and network errors
            // all keep retrying.
            if (!opened && attempt >= 3) {
              fetch(probeUrl)
                .then((res) => {
                  if (stopped) return;
                  if (res.status === 404) terminate();
                  else retry();
                })
                .catch(() => {
                  if (!stopped) retry();
                });
            } else {
              retry();
            }
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
        if (stableTimer != null) clearTimeout(stableTimer);
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
