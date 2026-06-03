// Typed client for the /api/* routes (see src/core/sync/webui-routes.ts). Every
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
}
export type Doc = DocSummary & { body: string | null };
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

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && (data as any).error)) {
    throw new Error((data && (data as any).error) || `${res.status} ${res.statusText}`);
  }
  return data as T;
}

const q = (s: string) => encodeURIComponent(s);

export const api = {
  // databases
  listDatabases: () => req<Db[]>("GET", "/api/databases"),
  createDatabase: (b: { name: string; icon?: string }) => req<Db>("POST", "/api/databases", b),
  updateDatabase: (id: string, b: { name?: string; icon?: string | null }) =>
    req<Db>("PATCH", `/api/database?id=${q(id)}`, b),
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
  updateDocument: (id: string, b: { title?: string; body?: string; parent_id?: string | null }) =>
    req<Doc>("PATCH", `/api/document?id=${q(id)}`, b),
  deleteDocument: (id: string) => req<{ ok: boolean }>("DELETE", `/api/document?id=${q(id)}`),

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
