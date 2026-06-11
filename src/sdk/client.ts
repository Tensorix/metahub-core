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

export interface SdkOptions {
  /** API origin; defaults to same-origin (hosted pages). */
  baseUrl?: string;
  /** Explicit Bearer token; defaults to the browser's stored one. */
  token?: string;
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

export function createClient(opts: SdkOptions = {}) {
  const base = (opts.baseUrl ?? "").replace(/\/$/, "");

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
      const renewed = await fetch(base + RENEW_PATH, {
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
    createRecord: (db: string, values: Record<string, unknown>) =>
      req<RecordInfo>("POST", `/api/records?db=${q(db)}`, values),
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

/** Ready-to-use same-origin client — what hosted site pages want. */
export const api = createClient();
