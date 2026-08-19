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
import type { DataMap } from "../core/sync/data-map-db.ts";
export type { DataMap };
export type { DataPlace, DataMapState } from "../core/data-map.ts";
import type { DeviceView, BucketPresence } from "../core/sync/devices.ts";
import type { RotateOutcome } from "../core/sync/peers.ts";
export type { DeviceView, RotateOutcome };
export interface BucketPresenceView {
  url: string;
  nodes?: BucketPresence[];
  error?: string;
}

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
  pendingPush?: boolean;
  error?: string;
  /** Non-fatal follow-ups (channel maintenance) after a successful data sync. */
  warnings?: string[];
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
  FieldHistoryEntry,
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
  FieldHistoryEntry,
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
  /** Raw synced register — only exactly "public" means public (default-deny). */
  visibility: string | null;
  spa: number;
  /** Raw serialized GrantSet register — parse via parseGrantSet only. */
  public_grants: string | null;
  file_count: number;
}

// Anonymous/guest data grants (mirrors core grants-core.ts shapes).
export type GrantOp = "read" | "create" | "update";
export interface GrantTable {
  db: string;
  ops: GrantOp[];
}
export interface GrantSet {
  v: 1;
  tables: GrantTable[];
}
// Not core SiteFileRow: content is deliberately not sent to the browser.
export interface SiteFile {
  id: string;
  site_id: string;
  path: string;
  content_type: string;
  encoding: string; // "utf8" | "base64" | "blob"
  /** Derived served-byte size; null when a blob's bytes aren't held locally. */
  size: number | null;
}

// Public capability shares (server-shaped; see server/share-routes.ts).
export interface ShareListItem {
  slug: string;
  kind: string;
  target_id: string;
  /** Human title of the shared object. */
  title: string;
  permission: string;
  transport: "server" | "s3";
  hosting?: "server" | "room" | "s3";
  /** Where it's served: a server address or a bucket name. */
  source: string;
  sourceKind: "server" | "peer" | "room" | "bucket";
  sourceUrl?: string;
  expiresAt: number | null;
  hasPassword: boolean;
  /** server: ready-to-copy link; s3: omitted (use renewShare to mint one). */
  url?: string;
  lifecycle?: "active" | "provisioning" | "cleanup_pending";
  /** s3 only: when the snapshot content was last exported (≠ link expiry). */
  contentUpdatedAt?: number;
}
export interface CreateShareBody {
  kind: "doc" | "database" | "site";
  ref: string;
  transport?: "server" | "s3";
  hosting?: "server" | "room";
  permission?: "view" | "edit";
  password?: string | null;
  expiresMs?: number | null;
  /** server: a peer url → create there; a base url → local served_base; omit → local. */
  server?: string | null;
  bucketUrl?: string | null;
  viewerBase?: string;
  /** Serialized GrantSet for the share's api/ surface (server transport only). */
  grants?: string | null;
  requestId?: string | null;
}
export interface ShareCreateResult {
  slug: string;
  kind: string;
  permission: string;
  transport: "server" | "s3";
  hosting: "server" | "room" | "s3";
  url: string;
  expiresAt: number | null;
  source: string;
}
export interface ShareTargetOpt {
  url: string;
  label: string;
  enabled?: boolean;
  lastStatus?: string | null;
  lastSuccessAt?: number | null;
}

export interface SiteHostingInfo {
  publicBaseUrl: string | null;
  scope: "local" | "lan" | "public" | null;
  node: string;
  pendingRollbacks: {
    siteId: string;
    peerUrl: string;
    targetUrl: string;
    requiredSeq: number;
    createdAt: number;
    lastError: string;
  }[];
  publishedSites: {
    siteId: string;
    targetBase: string;
    url: string;
    status: "ready" | "syncing";
    updatedAt: number;
  }[];
  channels: SiteChannelView[];
}
export interface SiteChannelView {
  id: string;
  siteId: string;
  audience: "public" | "link";
  hosting: "device" | "edge";
  controllerNodeId: string;
  targetRef: string;
  canonicalUrl: string | null;
  policyJson: string | null;
  desiredState: "active" | "revoked";
  status:
    | "provisioning"
    | "syncing"
    | "ready"
    | "rollback_pending"
    | "cleanup_pending"
    | "error"
    | "legacy_unverified"
    | "revoked"
    | "waiting_controller"
    | "unverified";
  lastVerifiedAt: number | null;
  lastError: string | null;
}
export interface SitePublishResult {
  access: "public" | "private";
  status:
    | "ready"
    | "syncing"
    | "private"
    | "rollback_pending"
    | "cleanup_pending";
  url: string | null;
  host: string | null;
  error?: string;
}
export interface EdgeRoomStatus {
  slug: string;
  url: string;
  status: string | null;
  lastSuccessAt: number | null;
  error: string | null;
}
export interface EdgeStatus {
  configured: boolean;
  endpoint?: string;
  version?: string | null;
  expectedVersion: string;
  aligned: boolean;
  reachable: boolean;
  error?: string;
  managed: boolean;
  /** Whether "Sign in with Cloudflare" (OAuth) is available on this build. */
  oauthConfigured?: boolean;
  capabilities?: ("inbox" | "room")[];
  wired?: { site: string; registered: boolean; error?: string }[];
  deployment?: {
    accountId: string;
    workerName: string;
    d1Name: string;
    workersSubdomain: string;
  };
  rooms: EdgeRoomStatus[];
  defaults: {
    workerName: string;
    d1Name: string;
    workersSubdomain: string;
    r2BucketName?: string;
  } | null;
  pending: {
    accountId: string;
    workerName: string;
    d1Name: string;
    d1Id?: string;
    workersSubdomain?: string;
    deploymentId: string;
    startedAt: number;
    step: string;
    updatedAt: number;
  } | null;
}
export interface EdgeConnectResult extends EdgeStatus {
  status: "connected";
  wired: { site: string; registered: boolean; error?: string }[];
  warnings: string[];
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

/** Fired after any successful record mutation. relation-titles.ts subscribes to
 *  keep cross-database title chips fresh in window (HTTP) mode, where no
 *  SYNCED_EVENT exists. Views deliberately do NOT reload on this — the mutating
 *  view already reconciles its own state. */
export const REC_INVALIDATE = "mh-rec-invalidate";

function touchesRecords(method: string, path: string): boolean {
  return method !== "GET" && path.startsWith("/api/record");
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

/** The token cookie the server sets for a `?token=` navigation (QR "open on your
 *  phone"). Not HttpOnly by design — see adoption below. */
function cookieToken(): string | null {
  try {
    for (const part of document.cookie.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === TOKEN_KEY) return decodeURIComponent(v.join("=")) || null;
    }
  } catch {
    /* no document (worker) */
  }
  return null;
}

function storedToken(): string | null {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) return t;
  } catch {
    return cookieToken(); // private mode: cookie only, no adoption possible
  }
  // A `?token=` navigation is persisted as a cookie by the server, which then
  // strips the token from the URL — so this session's only credential lives in
  // the cookie. Cookie authority is READ-ONLY server-side
  // (cookieMutationRejection), so adopt it into localStorage: without this the
  // whole app silently becomes read-only after a QR login.
  const c = cookieToken();
  if (c) {
    try {
      localStorage.setItem(TOKEN_KEY, c);
    } catch {
      /* private mode */
    }
  }
  return c;
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

/** Low-level XHR POST of raw bytes — the one transport that reports UPLOAD
 *  progress (fetch can't). Resolves { status, data } (data = parsed JSON or null). */
function xhrPost(
  path: string,
  file: Blob,
  token: string | null,
  ct: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.setRequestHeader("content-type", ct);
    if (onProgress)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON body */
      }
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.ontimeout = () => reject(new Error("timeout"));
    xhr.send(file);
  });
}

/** POST raw bytes with upload progress + the stored Bearer token; on 401, rotate
 *  the token once and retry (mirrors authFetch). Returns the parsed JSON body, or
 *  throws on HTTP/network error (the caller's offline-spool fallback handles it). */
async function uploadBlobXHR(
  path: string,
  file: Blob,
  ct: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<any> {
  const t = storedToken();
  let r = await xhrPost(path, file, t, ct, onProgress);
  if (r.status === 401 && t) {
    const renewed = await fetch(RENEW_PATH, { headers: { authorization: `Bearer ${t}` } }).catch(() => null);
    const d = renewed?.ok ? ((await renewed.json().catch(() => null)) as { token?: string } | null) : null;
    if (d?.token) {
      saveToken(d.token);
      r = await xhrPost(path, file, d.token, ct, onProgress);
    }
  }
  if (r.status >= 200 && r.status < 300 && r.data && !r.data.error) return r.data;
  throw new Error((r.data && r.data.error) || `${r.status}`);
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
  if (touchesRecords(method, path)) document.dispatchEvent(new CustomEvent(REC_INVALIDATE));
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
/** Bytes reclaimed by an orphan delete (or local eviction in the no-origin shell). */
export interface BlobDeleteResult {
  removed: number;
  freedBytes: number;
}
/** One cached blob as the Settings blob-manager popup sees it. Shared shape across
 *  the server (/api/blobs) and no-origin (Cache Storage) sources. */
export interface BlobRow {
  hash: string;
  size: number;
  contentType: string | null;
  lastAccess: number | null;
  pinned: boolean;
  /** Produced here, not yet flushed to a durable anchor — protected from clearing. */
  pending: boolean;
  /** Safe to drop locally: durable on the designated full set / re-fetchable. */
  clearable: boolean;
  /** A live document or site still references it; `!referenced` = orphan. */
  referenced: boolean;
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
/** Alias: uploads aren't image-only anymore (video/audio/file too). */
export type DocBlobUpload = DocImageUpload;

/** Friendly client-side upload caps by kind (the server enforces a single hard
 *  ceiling, see core MAX_BLOB_UPLOAD_BYTES). */
export const MAX_UPLOAD_BYTES: Record<"image" | "video" | "audio" | "file", number> = {
  image: 25 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
  file: 100 * 1024 * 1024,
};

/** Extension of a path/URL (no query/fragment), lowercased, or "". */
function urlExt(s: string): string {
  const clean = s.split(/[?#]/, 1)[0] ?? s;
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Best stable `/blob/<hash>.<ext>` URL: prefer the server's extension (correct
 *  type for known media), else the original filename's, else infer from the MIME
 *  type. A trustworthy extension lets the byte route serve the right content-type
 *  and lets the editor re-detect video/audio on reload. */
function blobUrlWithExt(hash: string, serverUrl: string, ct: string, filename: string): string {
  const ext = urlExt(serverUrl) || urlExt(filename) || extForType(ct);
  return `/blob/${hash}${ext ? "." + ext : ""}`;
}

/** Upload arbitrary doc bytes (image/video/audio/file) and return a stable
 *  `/blob/<hash>.<ext>` URL. Replica clients compose offline: when the upload
 *  can't reach the server, the bytes spool under the SAME hash the server would
 *  assign and the URL returns immediately (the SW serves from the spool); a later
 *  drain (online) pushes them to the server. */
async function uploadDocBlobImpl(
  file: Blob,
  onProgress?: (loaded: number, total: number) => void,
): Promise<DocBlobUpload> {
  const ct = file.type || "application/octet-stream";
  const filename = (file as File).name || "";
  try {
    const data = await uploadBlobXHR("/api/blob", file, ct, onProgress);
    void drainBlobSpool(); // online again — flush anything stranded earlier
    const d = data as DocBlobUpload;
    return { ...d, url: blobUrlWithExt(d.hash, d.url, ct, filename) };
  } catch (e) {
    if (!(replicaActive() || isNoOrigin())) throw e;
    const buf = await file.arrayBuffer();
    const hash = await blobHash32(buf);
    await spoolPut(hash, buf, ct);
    onProgress?.(buf.byteLength, buf.byteLength); // composed locally → instantly "done"
    return { hash, size: buf.byteLength, content_type: ct, url: blobUrlWithExt(hash, "", ct, filename) };
  }
}

const httpApi = {
  // databases
  listDatabases: () => req<Db[]>("GET", "/api/databases"),
  createDatabase: (b: { name: string; icon?: string }) => req<Db>("POST", "/api/databases", b),
  updateDatabase: (id: string, b: { name?: string; icon?: string | null; meta?: Record<string, unknown> | null }) =>
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
  renameSelectOption: (id: string, from: string, to: string) =>
    req<{ property: Prop; renamed: number }>("POST", `/api/property/option/rename?id=${q(id)}`, { from, to }),
  removeSelectOption: (id: string, name: string) =>
    req<{ property: Prop; cleared: number }>("POST", `/api/property/option/remove?id=${q(id)}`, { name }),

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
  recordFieldHistory: (id: string, prop: string) =>
    req<FieldHistoryEntry[]>("GET", `/api/record/field-history?id=${q(id)}&prop=${q(prop)}`),
  revertRecord: (id: string, to: string) =>
    req<RevertRecordResult>("POST", `/api/record/revert?id=${q(id)}`, { to }),
  nodes: () => req<NodeInfo[]>("GET", "/api/nodes"),
  // Rename THIS node. Careful: through the api proxy the target flips with
  // replicaActive() (hydration timing) — a rename UI must pick one end
  // deterministically (see DeviceGroupName: replicaEnabled() ? worker : HTTP).
  setNodeLabel: (label: string | null) => req<NodeInfo>("PATCH", "/api/node", { label }),

  // search
  search: (text: string, limit?: number) => {
    const p = new URLSearchParams({ q: text });
    if (limit != null) p.set("limit", String(limit));
    return req<Hit[]>("GET", `/api/search?${p}`);
  },

  // sync peers / pairing
  listPeers: () => req<Peer[]>("GET", "/api/peers"),
  // Workspace data map (mh status equivalent). Window mode asks the server
  // (the data home); a replica answers from its own local derivation.
  syncHealth: () => req<DataMap>("GET", "/api/sync/health"),
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
  // Unified device roster + the lost-device remedies. Grant tokens arrive as
  // 8-char prefixes — enough for display and prefix-revoke.
  listDevices: () => req<DeviceView[]>("GET", "/api/devices"),
  refreshDevicePresence: () =>
    req<{ devices: DeviceView[]; buckets: BucketPresenceView[] }>(
      "POST",
      "/api/devices/refresh",
    ),
  rotateServerS3Peer: (b: {
    url: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    newPassphrase?: string;
    oldPassphrase?: string;
    recoveryCode?: string;
  }) => req<RotateOutcome>("POST", "/api/peer/s3/rotate", b),
  serverS3Recovery: (url: string) =>
    req<{ url: string; code: string }>("GET", `/api/peer/s3/recovery?url=${q(url)}`),

  // sites (static file buckets served at /sites/<name>/)
  listSites: () => req<Site[]>("GET", "/api/sites"),
  listSiteFiles: (site: string) => req<SiteFile[]>("GET", `/api/site/files?site=${q(site)}`),
  createSite: (b: { name: string; title?: string }) => req<Site>("POST", "/api/sites", b),
  updateSite: (
    id: string,
    b: { name?: string; title?: string; visibility?: "public" | "private"; spa?: boolean },
  ) => req<Site>("PATCH", `/api/site?id=${q(id)}`, b),
  deleteSite: (id: string) => req<{ ok: boolean }>("DELETE", `/api/site?id=${q(id)}`),
  getSiteGrants: (id: string) => req<{ grants: GrantSet }>("GET", `/api/site/grants?id=${q(id)}`),
  setSiteGrants: (id: string, grants: GrantSet) =>
    req<{ grants: GrantSet }>("PUT", `/api/site/grants?id=${q(id)}`, grants),
  getSiteHosting: () => req<SiteHostingInfo>("GET", "/api/site-hosting"),
  setSiteHosting: (publicBaseUrl: string | null) =>
    req<SiteHostingInfo>("PATCH", "/api/site-hosting", { publicBaseUrl }),
  verifySiteHosting: (url: string) =>
    req<{ ok: boolean; url: string; scope: "local" | "lan" | "public"; node: string }>(
      "POST",
      "/api/site-hosting/verify",
      { url },
    ),
  publishSite: (b: {
    siteId: string;
    access: "public" | "private";
    grants?: GrantSet;
    targetBase?: string;
  }) => req<SitePublishResult>("POST", "/api/site/publish", b),
  recoverSitePublish: (siteId: string, targetBase: string) =>
    req<SitePublishResult>("POST", "/api/site/publish/recover", { siteId, targetBase }),
  revokeSiteChannel: (id: string) =>
    req<SiteChannelView>("PATCH", "/api/site/channel", {
      id,
      desiredState: "revoked",
    }),
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

  /** Upload doc bytes (image/video/audio/file) as a content-addressed blob;
   *  returns a /blob/<hash>.<ext> URL to embed. See uploadDocBlobImpl. */
  uploadDocBlob: uploadDocBlobImpl,
  /** @deprecated use uploadDocBlob — kept for older call sites. */
  uploadDocImage: uploadDocBlobImpl,

  // shares (public capability links)
  listShareServers: () => req<ShareTargetOpt[]>("GET", "/api/share/servers"),
  listShareBuckets: () => req<ShareTargetOpt[]>("GET", "/api/share/buckets"),
  listShares: (opts: { target?: string } = {}) =>
    req<ShareListItem[]>("GET", `/api/shares/all${opts.target ? `?target=${q(opts.target)}` : ""}`),
  listLocalShares: (opts: { target?: string } = {}) =>
    req<ShareListItem[]>("GET", `/api/shares${opts.target ? `?target=${q(opts.target)}` : ""}`),
  createShare: (b: CreateShareBody) => req<ShareCreateResult>("POST", "/api/share", b),
  revokeShare: (slug: string, via?: string) =>
    req<{ ok: boolean; status: "revoked" | "cleanup_pending" | "not_found" }>(
      "DELETE",
      `/api/share/managed?slug=${q(slug)}${via ? `&via=${q(via)}` : ""}`,
    ),
  renewShare: (slug: string, opts?: { refreshContent?: boolean }) =>
    req<ShareCreateResult>(
      "POST",
      `/api/share/renew?slug=${q(slug)}${opts?.refreshContent ? "&refresh_content=1" : ""}`,
    ),

  // Edge hosting
  getEdgeStatus: () => req<EdgeStatus>("GET", "/api/edge"),
  deployEdge: (b: {
    // OAuth path: a completed sign-in flow that holds the token server-side.
    flowId?: string;
    accountId?: string;
    // Fallback path (headless/CI): a pasted API token.
    apiToken?: string;
    workerName?: string;
    d1Name?: string;
    workersSubdomain?: string;
    confirmed: boolean;
    /** Keep the OAuth token alive for a follow-up /api/edge/r2 call. */
    keepFlow?: boolean;
  }) =>
    req<{
      status: "deployed";
      endpoint: string;
      wired: { site: string; registered: boolean; error?: string }[];
      warnings: string[];
    }>("POST", "/api/edge/deploy", b),
  // One-stop companion: create an R2 sync bucket on the same sign-in. S3
  // credentials cannot be minted via OAuth (no scope exists) — the result's
  // credentialsUrl is where the user creates and copies them.
  provisionEdgeR2: (b: {
    flowId?: string;
    accountId?: string;
    apiToken?: string;
    bucketName?: string;
    confirmed: boolean;
    keepFlow?: boolean;
  }) =>
    req<{
      status: "created" | "adopted";
      bucketName: string;
      endpoint: string;
      credentialsUrl: string;
    }>("POST", "/api/edge/r2", b),
  // "Sign in with Cloudflare" — the token stays server-side; the browser only
  // opens `authUrl`, polls status for the discovered accounts, then deploys by flowId.
  beginEdgeOAuth: () =>
    req<{ flowId: string; authUrl: string }>("POST", "/api/edge/oauth/begin"),
  edgeOAuthStatus: (flowId: string) =>
    req<{
      state: "pending" | "ready" | "error";
      accounts?: { id: string; name: string }[];
      error?: string;
    }>("GET", `/api/edge/oauth/status?flowId=${q(flowId)}`),
  cancelEdgeOAuth: (flowId: string) =>
    req<{ ok: boolean }>("DELETE", `/api/edge/oauth?flowId=${q(flowId)}`),
  connectEdge: (endpoint: string, token: string) =>
    req<EdgeConnectResult>("PUT", "/api/edge/connect", { endpoint, token }),
  disconnectEdge: () => req<{ ok: boolean }>("DELETE", "/api/edge"),

  // blob cache (Settings storage panel)
  blobCache: () => req<BlobCacheInfo>("GET", "/api/blob-cache"),
  verifyBlobCache: () => req<BlobCacheInfo>("POST", "/api/blob-cache/verify"),
  clearBlobCache: () => req<BlobClearResult>("POST", "/api/blob-cache/clear"),
  setBlobPolicy: (b: { full_nodes?: string[]; redundancy?: "all" | "any" }) =>
    req<BlobPolicyResult>("POST", "/api/blob-policy", b),
  pinBlob: (hash: string, pinned: boolean) =>
    req<{ hash: string; pinned: boolean }>("POST", "/api/blob-cache/pin", { hash, pinned }),
  // per-blob manager (Settings storage → Blob 管理 popup)
  blobs: () => req<BlobRow[]>("GET", "/api/blobs"),
  clearBlobs: (hashes: string[]) => req<BlobClearResult>("POST", "/api/blobs/clear", { hashes }),
  deleteBlobs: (hashes: string[]) => req<BlobDeleteResult>("POST", "/api/blobs/delete", { hashes }),

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
