// Typed client for the /api/* routes (see src/webui/server/routes.ts). Every
// write goes through the same core functions the CLI uses, so changes land in
// the CRDT oplog and replicate over /sync. Ids are carried as query params to
// match the server's exact-path route matcher.
//
// Exported `api` is a selector: HTTP by default, the local OPFS replica
// (data/local-api.ts) when this browser enabled offline mode — see the Proxy
// at the bottom of this file.

import { localApi, localSites, replicaActive, isNoOrigin } from "./data/local-api.ts";
import {
  blobHash32,
  extForType,
  spoolPut,
  spoolPending,
  spoolDelete,
  cachePut,
} from "./data/blob-store.ts";
import type { S3Config } from "../core/sync/storage.ts";

// API row types come straight from core via type-only imports — erased at
// build time, so nothing of core leaks into the browser bundle. Adding a field
// in core now reaches the frontend without a hand-maintained mirror. Types
// that stay local below are genuinely server-shaped DTOs, not core rows.
import type {
  PropType,
  PropertyConfig as PropConfig,
  PropertyRow as Prop,
} from "../core/properties.ts";
import type { DatabaseRow as Db } from "../core/databases.ts";
import type { RecordRow as Rec } from "../core/records.ts";
import type { DocumentSummary as DocSummary } from "../core/documents.ts";
export type { PropType, PropConfig, Prop, Db, Rec, DocSummary };

export type Doc = DocSummary & {
  body: string | null;
  /** Read/edit token; echo back as `if_match` on update to detect conflicts. */
  version?: string;
};
export interface Hit {
  type: string;
  id: string;
  database_id: string | null;
  title?: string;
  snippet: string;
}
export interface Peer {
  url: string;
  pull_cursor: number;
  push_cursor: number;
  token: string | null;
  label: string | null;
  node_id: string | null;
  enabled: number;
  last_sync_at: number | null;
  last_success_at: number | null;
  last_status: string | null;
  last_error: string | null;
}
/** An S3 bucket attached to the server (data home), as the WebUI sees it — no
 *  secrets. `publish` = this server is the bucket's publisher. */
export interface S3Peer {
  url: string;
  label: string | null;
  enabled: number;
  status: string | null;
  error: string | null;
  lastSyncAt: number | null;
  lastAttemptAt: number | null;
  publish: boolean;
  endpoint: string | null;
  bucket: string | null;
  // Non-secret config so a replica can re-activate this bucket on itself with
  // only the secret re-entered (never the secretAccessKey / passphrase).
  region: string | null;
  prefix: string | null;
  accessKeyId: string | null;
  encrypt: boolean;
  virtualHostedStyle: boolean | null;
}
export interface S3PeerInput {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  prefix?: string;
  encrypt?: boolean;
  passphrase?: string;
  /** Browser origin(s) the server should open bucket CORS for, so a replica
   *  behind this server can sync via the bucket directly. Usually [location.origin]. */
  corsOrigins?: string[];
}
export interface PairingCode {
  code: string;
  exp: number;
}
export interface PeerSyncOutcome {
  url: string;
  ok: boolean;
  pushed?: number;
  pulled?: number;
  error?: string;
}
export interface Grant {
  token: string;
  peer_url: string | null;
  node_id: string | null;
  created_at: number | null;
}
// History types are produced verbatim by core (src/core/history.ts) and pass
// through the HTTP layer unchanged — re-export, don't mirror.
import type {
  RevisionKind,
  DocRevision,
  RecordRevision,
  FieldChange,
  DatabaseActivityEntry,
  DocumentVersionState as DocVersionState,
  RecordVersionState,
  RevertDocResult,
  RevertRecordResult,
} from "../core/history.ts";
export type {
  RevisionKind,
  DocRevision,
  RecordRevision,
  FieldChange,
  DatabaseActivityEntry,
  DocVersionState,
  RecordVersionState,
  RevertDocResult,
  RevertRecordResult,
};

// Server-shaped: assembled in routes.ts (no core row behind it).
export interface NodeInfo {
  node_id: string;
  label: string | null;
  self: boolean;
}

// Not core SiteRow: the sites route adds the computed file_count.
export interface Site {
  id: string;
  name: string;
  title: string | null;
  created_hlc: string;
  file_count: number;
}
// Not core SiteFileRow: content is deliberately not sent to the browser.
export interface SiteFile {
  id: string;
  site_id: string;
  path: string;
  content_type: string;
  encoding: string; // "utf8" | "base64" | "blob"
}

/** Thrown by req(): carries the server's error `code` (see core/errors.ts) so
 *  callers dispatch on it (`"stale"` → conflict UI) instead of message text. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Fired on document/window after any successful mutation that can change the
 *  sidebar nav (databases, documents). The App subscribes once and reloads the
 *  nav — call sites don't (and must not) reload it by hand, so a forgotten
 *  manual refresh can't go stale. */
export const NAV_INVALIDATE = "mh-nav-invalidate";

function touchesNav(method: string, path: string): boolean {
  return method !== "GET" && (path.startsWith("/api/database") || path.startsWith("/api/document"));
}

// ---- auth -------------------------------------------------------------------
// The app attaches the stored token itself instead of relying on the
// server-injected fetch shim: a PWA shell served from the service worker cache
// is byte-identical to what the server sent, but new worker contexts and
// non-window fetches never pass through window.fetch, and owning the logic
// here keeps renewal behavior identical online and offline. The shim still
// covers hosted /sites/* pages; it skips requests that already carry an
// authorization header, so the two never fight.

const TOKEN_KEY = "mh_token";
const RENEW_PATH = "/auth/token";

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveToken(t: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* private mode */
  }
  document.cookie = `${TOKEN_KEY}=${encodeURIComponent(t)}; path=/; SameSite=Strict; Max-Age=31536000`;
}

/** The current server access token, for building an origin "open on your phone"
 *  QR (`<server>/?token=…`) the device scans to get in without typing it. */
export function currentToken(): string | null {
  return storedToken();
}

/** fetch with the stored Bearer token; on 401, swap an in-grace token for the
 *  current one via /auth/token and retry once (seamless rotation). */
export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const t = storedToken();
  const headers = new Headers(init.headers);
  if (t && !headers.has("authorization")) headers.set("authorization", `Bearer ${t}`);
  const res = await fetch(path, { ...init, headers });
  if (res.status !== 401 || !t) return res;

  const renewed = await fetch(RENEW_PATH, {
    headers: { authorization: `Bearer ${t}` },
  }).catch(() => null);
  if (!renewed?.ok) return res;
  const d = (await renewed.json().catch(() => null)) as { token?: string } | null;
  if (!d?.token) return res;
  saveToken(d.token);
  headers.set("authorization", `Bearer ${d.token}`);
  return fetch(path, { ...init, headers });
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await authFetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && (data as any).error)) {
    throw new ApiError(
      (data && (data as any).error) || `${res.status} ${res.statusText}`,
      (data as any)?.code,
      res.status,
    );
  }
  if (touchesNav(method, path)) document.dispatchEvent(new CustomEvent(NAV_INVALIDATE));
  return data as T;
}

const q = (s: string) => encodeURIComponent(s);

/** Push blob bytes composed offline (spool) to the server for an origin-backed
 *  replica — the page holds the master token POST /api/blob needs (a no-origin
 *  client drains to its bucket from the worker instead). On success the bytes move
 *  to the evictable byte cache and leave the spool. Best-effort + single-flight;
 *  stops at the first failure (still offline) and retries on the next trigger. */
let draining = false;
export async function drainBlobSpool(): Promise<void> {
  if (draining || isNoOrigin()) return;
  draining = true;
  try {
    for (const e of await spoolPending()) {
      let res: Response;
      try {
        res = await authFetch("/api/blob", {
          method: "POST",
          headers: { "content-type": e.content_type },
          body: e.bytes,
        });
      } catch {
        break; // still offline — retry on the next online/upload
      }
      if (!res.ok) break;
      await cachePut(e.hash, e.bytes, e.content_type).catch(() => {});
      await spoolDelete(e.hash).catch(() => {});
    }
  } finally {
    draining = false;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => void drainBlobSpool());
}

// Blob cache (document images / large files): managed on the server (data home);
// always HTTP — the browser replica has no local counterpart for the node cache.
export interface BlobCacheStats {
  totalBytes: number;
  clearableBytes: number;
  retainedBytes: number;
  count: number;
  clearableCount: number;
}
export interface BlobPolicyInfo {
  fullNodes: string[];
  redundancy: "all" | "any";
}
export interface BlobCacheNode {
  nodeId: string;
  label: string | null;
  self: boolean;
}
export interface BlobCacheBucket {
  url: string;
  label: string | null;
  bucket: string | null;
}
export interface BlobCacheInfo {
  stats: BlobCacheStats;
  policy: BlobPolicyInfo;
  nodes: BlobCacheNode[];
  /** Attached object-storage buckets, selectable as full-blob anchors. */
  buckets: BlobCacheBucket[];
  /** Auto-evict over this many bytes; 0 = disabled. */
  quotaBytes: number;
  pinnedCount: number;
  pinnedBytes: number;
  /** Epoch-ms of the last anchor-presence verify; null = never / invalidated. */
  lastVerifiedAt: number | null;
  /** Anchors the last verify couldn't reach (only populated by verifyBlobCache). */
  unreachableAnchors: string[];
}
export interface BlobClearResult {
  cleared: number;
  freedBytes: number;
  skipped: number;
}
export interface BlobPolicyResult {
  policy: BlobPolicyInfo;
}
export interface DocImageUpload {
  hash: string;
  size: number;
  content_type: string;
  /** Stable served path to embed in the document, e.g. /blob/<hash>.png */
  url: string;
}

const httpApi = {
  // databases
  listDatabases: () => req<Db[]>("GET", "/api/databases"),
  createDatabase: (b: { name: string; icon?: string }) => req<Db>("POST", "/api/databases", b),
  updateDatabase: (id: string, b: { name?: string; icon?: string | null }) =>
    req<Db>("PATCH", `/api/database?id=${q(id)}`, b),
  duplicateDatabase: (id: string, b?: { name?: string; icon?: string }) =>
    req<Db>("POST", `/api/database/duplicate?id=${q(id)}`, b ?? {}),
  deleteDatabase: (id: string) => req<{ ok: boolean }>("DELETE", `/api/database?id=${q(id)}`),

  // properties
  listProperties: (dbId: string) => req<Prop[]>("GET", `/api/properties?db=${q(dbId)}`),
  createProperty: (b: { db: string; name: string; type: PropType; config?: PropConfig }) =>
    req<Prop>("POST", "/api/properties", b),
  updateProperty: (
    id: string,
    b: { name?: string; type?: PropType; config?: PropConfig; position?: number },
  ) => req<Prop>("PATCH", `/api/property?id=${q(id)}`, b),
  setColumnWidth: (id: string, width: number) =>
    req<Prop>("PATCH", `/api/property/width?id=${q(id)}`, { width }),
  deleteProperty: (id: string) => req<{ ok: boolean }>("DELETE", `/api/property?id=${q(id)}`),

  // records
  listRecords: (dbId: string, opts: { sort?: string; limit?: number } = {}) => {
    const p = new URLSearchParams({ db: dbId });
    if (opts.sort) p.set("sort", opts.sort);
    if (opts.limit != null) p.set("limit", String(opts.limit));
    return req<Rec[]>("GET", `/api/records?${p}`);
  },
  createRecord: (dbId: string, values: Record<string, unknown>) =>
    req<Rec>("POST", `/api/records?db=${q(dbId)}`, values),
  getRecord: (id: string) => req<Rec>("GET", `/api/record?id=${q(id)}`),
  updateRecord: (id: string, values: Record<string, unknown>) =>
    req<Rec>("PATCH", `/api/record?id=${q(id)}`, values),
  moveRecord: (id: string, target: string, where: "before" | "after") =>
    req<Rec>("PATCH", `/api/record/order?id=${q(id)}`, { target, where }),
  deleteRecord: (id: string) => req<{ ok: boolean }>("DELETE", `/api/record?id=${q(id)}`),

  // documents
  listDocuments: (dbId?: string) =>
    req<DocSummary[]>("GET", dbId ? `/api/documents?db=${q(dbId)}` : "/api/documents"),
  listDocumentsByParent: (parentId: string) =>
    req<DocSummary[]>("GET", `/api/documents?parent=${q(parentId)}`),
  createDocument: (b: { title: string; body?: string; database_id?: string; parent_id?: string }) =>
    req<Doc>("POST", "/api/documents", b),
  getDocument: (id: string) => req<Doc>("GET", `/api/document?id=${q(id)}`),
  updateDocument: (
    id: string,
    b: { title?: string; body?: string; parent_id?: string | null; if_match?: string },
  ) => req<Doc>("PATCH", `/api/document?id=${q(id)}`, b),
  moveDocument: (id: string, target: string, where: "before" | "after" | "into") =>
    req<Doc>("PATCH", `/api/document/move?id=${q(id)}`, { target, where }),
  duplicateDocument: (id: string, b?: { title?: string; parent_id?: string | null }) =>
    req<Doc>("POST", `/api/document/duplicate?id=${q(id)}`, b ?? {}),
  deleteDocument: (id: string) => req<{ ok: boolean }>("DELETE", `/api/document?id=${q(id)}`),

  // history
  documentHistory: (id: string) => req<DocRevision[]>("GET", `/api/document/history?id=${q(id)}`),
  documentAt: (id: string, version: string) =>
    req<DocVersionState>("GET", `/api/document/at?id=${q(id)}&version=${q(version)}`),
  revertDocument: (id: string, b: { to: string; if_match?: string }) =>
    req<RevertDocResult>("POST", `/api/document/revert?id=${q(id)}`, b),
  recordHistory: (id: string) => req<RecordRevision[]>("GET", `/api/record/history?id=${q(id)}`),
  databaseActivity: (dbId: string, limit?: number) =>
    req<DatabaseActivityEntry[]>(
      "GET",
      `/api/database/activity?db=${q(dbId)}${limit != null ? `&limit=${limit}` : ""}`,
    ),
  recordAt: (id: string, version: string) =>
    req<RecordVersionState>("GET", `/api/record/at?id=${q(id)}&version=${q(version)}`),
  revertRecord: (id: string, to: string) =>
    req<RevertRecordResult>("POST", `/api/record/revert?id=${q(id)}`, { to }),
  nodes: () => req<NodeInfo[]>("GET", "/api/nodes"),

  // search
  search: (text: string, limit?: number) => {
    const p = new URLSearchParams({ q: text });
    if (limit != null) p.set("limit", String(limit));
    return req<Hit[]>("GET", `/api/search?${p}`);
  },

  // sync peers / pairing
  listPeers: () => req<Peer[]>("GET", "/api/peers"),
  newPairingCode: () => req<PairingCode>("POST", "/api/pair/new"),
  addPeerByPairing: (b: { url: string; code: string; self_url?: string }) =>
    req<{ node_id: string; url: string }>("POST", "/api/peers/pair", b),
  updatePeer: (url: string, b: { enabled?: boolean; label?: string }) =>
    req<{ ok: boolean }>("PATCH", `/api/peer?url=${q(url)}`, b),
  removePeer: (url: string) => req<{ ok: boolean }>("DELETE", `/api/peer?url=${q(url)}`),
  syncPeer: (url: string) => req<PeerSyncOutcome>("POST", `/api/peer/sync?url=${q(url)}`),
  // S3 buckets attached to the server (origin mode: the server is the data home
  // + publisher). The browser-replica's own bucket peers go through the worker
  // (replica.ts), not these.
  listServerS3Peers: () => req<S3Peer[]>("GET", "/api/peers/s3"),
  addServerS3Peer: (b: S3PeerInput) => req<S3Peer>("POST", "/api/peer/s3", b),
  // Full config (incl. secret) for one server bucket — desktop-only, to build a
  // phone-enroll QR (the desktop renderer has no replica to read it from).
  serverS3Config: (url: string) => req<S3Config>("GET", `/api/peer/s3/config?url=${q(url)}`),
  listGrants: () => req<Grant[]>("GET", "/api/grants"),
  revokeGrant: (token: string) => req<{ revoked: number }>("DELETE", `/api/grant?token=${q(token)}`),

  // sites (static file buckets served at /sites/<name>/)
  listSites: () => req<Site[]>("GET", "/api/sites"),
  listSiteFiles: (site: string) => req<SiteFile[]>("GET", `/api/site/files?site=${q(site)}`),
  createSite: (b: { name: string; title?: string }) => req<Site>("POST", "/api/sites", b),
  updateSite: (id: string, b: { name?: string; title?: string }) =>
    req<Site>("PATCH", `/api/site?id=${q(id)}`, b),
  deleteSite: (id: string) => req<{ ok: boolean }>("DELETE", `/api/site?id=${q(id)}`),
  deleteSiteFile: (site: string, path: string) =>
    req<{ ok: boolean }>("DELETE", `/api/site/file?site=${q(site)}&path=${q(path)}`),
  /** Raw-bytes upload — can't use req() (it JSON-stringifies the body). */
  uploadSiteFile: async (site: string, path: string, file: Blob): Promise<SiteFile> => {
    const res = await authFetch(`/api/site/file?site=${q(site)}&path=${q(path)}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || (data && (data as any).error)) {
      throw new Error((data && (data as any).error) || `${res.status} ${res.statusText}`);
    }
    return data as SiteFile;
  },

  /** Upload a document image as a content-addressed blob; returns its /blob/<hash>
   *  URL to embed in markdown. Raw bytes (can't use req(), which JSON-stringifies).
   *  Replica clients can compose offline: when the upload can't reach the server,
   *  the bytes are spooled under the SAME hash the server would assign and the
   *  stable URL is returned immediately (the SW serves them from the spool); a
   *  later drain (online) pushes them to the server. */
  uploadDocImage: async (file: Blob): Promise<DocImageUpload> => {
    try {
      const res = await authFetch("/api/blob", {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && !(data as any).error) {
        void drainBlobSpool(); // online again — flush anything stranded earlier
        return data as DocImageUpload;
      }
      throw new Error((data && (data as any).error) || `${res.status} ${res.statusText}`);
    } catch (e) {
      if (!(replicaActive() || isNoOrigin())) throw e;
      const buf = await file.arrayBuffer();
      const hash = await blobHash32(buf);
      const ct = file.type || "application/octet-stream";
      await spoolPut(hash, buf, ct);
      const ext = extForType(ct);
      return { hash, size: buf.byteLength, content_type: ct, url: `/blob/${hash}${ext ? "." + ext : ""}` };
    }
  },

  // blob cache (Settings storage panel)
  blobCache: () => req<BlobCacheInfo>("GET", "/api/blob-cache"),
  verifyBlobCache: () => req<BlobCacheInfo>("POST", "/api/blob-cache/verify"),
  clearBlobCache: () => req<BlobClearResult>("POST", "/api/blob-cache/clear"),
  setBlobPolicy: (b: { full_nodes?: string[]; redundancy?: "all" | "any" }) =>
    req<BlobPolicyResult>("POST", "/api/blob-policy", b),
  pinBlob: (hash: string, pinned: boolean) =>
    req<{ hash: string; pinned: boolean }>("POST", "/api/blob-cache/pin", { hash, pinned }),

  // version of the running core (sidecar)
  version: () => req<{ version: string }>("GET", "/api/version"),
};

export type Api = typeof httpApi;

/**
 * The api object the app consumes. Per-call routing: when this browser's
 * offline replica is enabled AND hydrated (see replicaActive in
 * data/replica.ts), data methods execute against the local OPFS database via
 * the worker; everything else — and every call before hydration or after a
 * worker failure — falls through to HTTP. Admin/server methods (peers, sites
 * upload, version, pairing management) have no local counterpart and always
 * go over HTTP.
 */
export const api: Api = new Proxy(httpApi, {
  get(target, prop, receiver) {
    if (replicaActive()) {
      if (prop in localApi) return (localApi as Record<PropertyKey, unknown>)[prop];
      // Sites management routes local only in no-origin mode; in origin mode it
      // stays HTTP so the server keeps handling large-binary blob uploads.
      if (isNoOrigin() && prop in localSites) {
        return (localSites as Record<PropertyKey, unknown>)[prop];
      }
    }
    return Reflect.get(target, prop, receiver);
  },
}) as Api;

export const TYPE_META: Record<PropType, { ic: string; t: string }> = {
  text: { ic: "text", t: "文本" },
  number: { ic: "hash", t: "数字" },
  select: { ic: "select", t: "单选" },
  multi_select: { ic: "multi", t: "多选" },
  checkbox: { ic: "checkbox", t: "复选框" },
  date: { ic: "calendar", t: "日期" },
  url: { ic: "link", t: "链接" },
  relation: { ic: "relation", t: "关联" },
};
