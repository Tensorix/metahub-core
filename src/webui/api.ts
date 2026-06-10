// Typed client for the /api/* routes (see src/webui/server/routes.ts). Every
// write goes through the same core functions the CLI uses, so changes land in
// the CRDT oplog and replicate over /sync. Ids are carried as query params to
// match the server's exact-path route matcher.

export type PropType =
  | "text"
  | "number"
  | "checkbox"
  | "select"
  | "multi_select"
  | "date"
  | "relation"
  | "url";

export interface PropConfig {
  options?: string[];
  database?: string;
  indexed?: boolean;
  width?: number; // table column width in px
}

export interface Db {
  id: string;
  name: string;
  icon: string | null;
  created_hlc?: string;
}
export interface Prop {
  id: string;
  database_id: string;
  name: string;
  type: PropType;
  config: PropConfig | null;
  position: number;
}
export interface Rec {
  id: string;
  database_id: string;
  values: Record<string, unknown>;
}
export interface DocSummary {
  id: string;
  title: string;
  database_id: string | null;
  parent_id: string | null;
  created_hlc?: string;
  order_key?: string | null;
}
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
  last_status: string | null;
  last_error: string | null;
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
/** Source of a history revision: a user edit, a repairHub fix, or a revert. */
export type RevisionKind = "user" | "repair" | "revert";
interface RevisionBase {
  /** Version token — pass as `to` on revert / `version` on the at-version reads. */
  version: string;
  at: string; // ISO 8601
  node_id: string;
  kind: RevisionKind;
  changes: number;
  created: boolean;
  deleted: boolean;
}
export interface DocRevision extends RevisionBase {
  title_changed: boolean;
  blocks_changed: number;
  blocks_deleted: number;
}
export interface RecordRevision extends RevisionBase {
  fields: string[]; // property ids of the cells written
  moved: boolean;
}
export interface FieldChange {
  prop: string;
  before?: unknown;
  after?: unknown; // missing key = the cell did not exist on that side
}
export interface DatabaseActivityEntry extends RecordRevision {
  record_id: string;
  record_title: string | null;
  diffs: FieldChange[];
}
export interface DocVersionState {
  id: string;
  title: string;
  body: string;
  deleted: boolean;
  version: string;
}
export interface RecordVersionState {
  id: string;
  database_id: string | null;
  deleted: boolean;
  data: Record<string, unknown>; // keyed by property id
  version: string;
}
export interface RevertDocResult {
  id: string;
  changed: boolean;
  restored: string;
  version: string;
  undeleted: boolean;
}
export interface RevertRecordResult {
  id: string;
  changed: boolean;
  fields: string[];
  undeleted: boolean;
  restored: string;
}
export interface NodeInfo {
  node_id: string;
  label: string | null;
  self: boolean;
}

export interface Site {
  id: string;
  name: string;
  title: string | null;
  created_hlc: string;
  file_count: number;
}
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

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
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

export const api = {
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
    const res = await fetch(`/api/site/file?site=${q(site)}&path=${q(path)}`, {
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

  // version of the running core (sidecar)
  version: () => req<{ version: string }>("GET", "/api/version"),
};

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
