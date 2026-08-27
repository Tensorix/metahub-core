// Local-first implementation of the data half of the api surface (api.ts):
// same method names, same shapes, backed by the browser replica's worker RPC
// instead of HTTP. api.ts routes each call here whenever replicaActive().
//
// Admin/server-side methods (peers, grants, pairing management, sites upload,
// /api/version) intentionally have no local counterpart — they describe the
// server, not the data, and stay online-only.

import { call, replicaActive, isNoOrigin } from "./replica.ts";
import { ApiError, NAV_INVALIDATE, REC_INVALIDATE } from "../api.ts";
import { ReplicaError } from "./replica.ts";

export { replicaActive, isNoOrigin };

/** Same status mapping the HTTP layer uses, so ApiError consumers (e.g. the
 *  editor's stale-conflict handling) behave identically on the local path. */
const CODE_STATUS: Record<string, number> = {
  invalid_input: 400,
  not_found: 404,
  ambiguous: 400,
  stale: 409,
  conflict: 409,
  auth: 401,
  network: 502,
};

// The audit revert can rewrite ANY dataset — databases, documents, records,
// properties — so it invalidates both caches unconditionally.
const TOUCHES_EVERYTHING = new Set(["revertChangeGroup"]);

function touchesNav(op: string): boolean {
  return TOUCHES_EVERYTHING.has(op) || /^(create|update|delete|move|duplicate|revert)(Database|Document)/.test(op);
}

function touchesRecords(op: string): boolean {
  return TOUCHES_EVERYTHING.has(op) || /^(create|update|delete|move|revert)Record/.test(op);
}

/** RPC with HTTP-parity error translation + nav invalidation. */
async function rpc<T>(op: string, ...args: unknown[]): Promise<T> {
  try {
    const out = await call<T>(op, ...args);
    if (touchesNav(op)) document.dispatchEvent(new CustomEvent(NAV_INVALIDATE));
    if (touchesRecords(op)) document.dispatchEvent(new CustomEvent(REC_INVALIDATE));
    return out;
  } catch (e) {
    if (e instanceof ReplicaError) {
      throw new ApiError(e.message, e.code, e.code ? (CODE_STATUS[e.code] ?? 400) : 0);
    }
    throw e;
  }
}

export const localApi = {
  // databases
  listDatabases: () => rpc("listDatabases"),
  createDatabase: (b: unknown) => rpc("createDatabase", b),
  updateDatabase: (id: string, b: unknown) => rpc("updateDatabase", id, b),
  duplicateDatabase: (id: string, b?: unknown) => rpc("duplicateDatabase", id, b),
  deleteDatabase: (id: string) => rpc("deleteDatabase", id),
  databaseActivity: (dbId: string, limit?: number) => rpc("listDatabaseActivity", dbId, limit),

  // properties
  listProperties: (dbId: string) => rpc("listProperties", dbId),
  createProperty: (b: { db: string; name: string; type: unknown; config?: unknown }) => {
    const { db, ...rest } = b;
    return rpc("addProperty", db, rest);
  },
  updateProperty: (id: string, b: unknown) => rpc("updateProperty", id, b),
  setColumnWidth: (id: string, width: number) => rpc("setPropertyWidth", id, width),
  deleteProperty: (id: string) => rpc("removeProperty", id),
  renameSelectOption: (id: string, from: string, to: string) =>
    rpc("renameSelectOption", id, from, to),
  removeSelectOption: (id: string, name: string) => rpc("removeSelectOption", id, name),

  // records
  listRecords: (dbId: string, opts: { sort?: string; limit?: number } = {}) =>
    rpc("listRecords", dbId, opts),
  createRecord: (dbId: string, values: Record<string, unknown>) =>
    rpc("createRecord", dbId, values),
  getRecord: (id: string) => rpc("getRecord", id),
  updateRecord: (id: string, values: Record<string, unknown>) => rpc("updateRecord", id, values),
  moveRecord: (id: string, target: string, where: "before" | "after") =>
    rpc("moveRecord", id, target, where),
  deleteRecord: (id: string) => rpc("deleteRecord", id),
  recordHistory: (id: string) => rpc("listRecordRevisions", id),
  recordAt: (id: string, version: string) => rpc("recordAtVersion", id, version),
  recordFieldHistory: (id: string, prop: string) => rpc("recordFieldHistory", id, prop),
  revertRecord: (id: string, to: string) => rpc("revertRecord", id, to),

  // audit
  auditList: (opts?: { limit?: number; before?: string; actor?: string }) =>
    rpc("listAuditEntries", opts),
  auditEntry: (txn: string) => rpc("auditEntryDetail", txn),
  auditRevert: (txn: string) => rpc("revertChangeGroup", txn),

  // documents
  listDocuments: (dbId?: string) =>
    rpc("listDocuments", dbId ? { database_id: dbId } : undefined),
  listDocumentsByParent: (parentId: string) => rpc("listDocuments", { parent_id: parentId }),
  createDocument: (b: unknown) => rpc("createDocument", b),
  getDocument: (id: string) => rpc("getDocument", id),
  updateDocument: (
    id: string,
    b: { title?: string; body?: string; parent_id?: string | null; if_match?: string },
  ) => {
    const { if_match, ...fields } = b;
    return rpc("updateDocument", id, fields, if_match);
  },
  moveDocument: (id: string, target: string, where: "before" | "after" | "into") =>
    rpc("moveDocument", id, target, where),
  duplicateDocument: (id: string, b?: { title?: string; parent_id?: string | null }) =>
    rpc("duplicateDocument", id, b),
  deleteDocument: (id: string) => rpc("deleteDocument", id),
  documentHistory: (id: string) => rpc("listDocumentRevisions", id),
  documentAt: (id: string, version: string) => rpc("documentAtVersion", id, version),
  revertDocument: (id: string, b: { to: string; if_match?: string }) =>
    rpc("revertDocument", id, b.to, b.if_match),

  // shares, nodes + search
  // The ordinary UI only needs this browser/node's own share badges. Keep it
  // on the replica instead of falling through to the server-wide fan-out.
  listLocalShares: (opts: { target?: string } = {}) =>
    rpc("listLocalShares", opts.target),
  nodes: () => rpc("nodes"),
  search: (text: string, limit?: number) => rpc("search", text, limit),

  // Data map: a replica is a full node, so its own local derivation (which
  // includes the origin server as an http peer) is this device's honest
  // "where is my data" answer — and it works offline. Window mode falls
  // through to the server's /api/sync/health.
  syncHealth: () => rpc("dataMap"),
  setNodeLabel: (label: string | null) => rpc("setNodeLabel", label),
};

/**
 * Sites management against the local replica. Kept separate from localApi: it's
 * routed locally ONLY in no-origin mode (see api.ts). In origin mode sites stay
 * on HTTP so the server still handles large-binary blob uploads — putFileInline
 * can't store blobs, so local routing there would regress big-file uploads.
 */
export const localSites = {
  listSites: () => rpc("listSites"),
  listSiteFiles: (site: string) => rpc("listSiteFiles", site),
  createSite: (b: { name: string; title?: string }) => rpc("createSite", b),
  updateSite: (
    id: string,
    b: { name?: string; title?: string; visibility?: "public" | "private"; spa?: boolean },
  ) => rpc("updateSite", id, b),
  deleteSite: (id: string) => rpc("deleteSite", id),
  getSiteGrants: (id: string) => rpc("getSiteGrants", id),
  setSiteGrants: (id: string, grants: unknown) => rpc("setSiteGrants", id, grants),
  getSiteHosting: () => rpc("siteHosting"),
  revokeSiteChannel: (id: string) => rpc("revokeSiteChannel", id),
  deleteSiteFile: (site: string, path: string) => rpc("deleteSiteFile", site, path),
  uploadSiteFile: async (site: string, path: string, file: Blob) =>
    rpc("putSiteFile", site, path, await file.arrayBuffer(), file.type || undefined),
  getEdgeStatus: () => rpc("edgeStatus"),
  connectEdge: (endpoint: string, token: string) => rpc("connectEdge", endpoint, token),
  disconnectEdge: () => rpc("disconnectEdge"),
  listShareServers: () => Promise.resolve([]),
  listShareBuckets: () => Promise.resolve([]),
  listShares: (opts: { target?: string } = {}) => rpc("listLocalShares", opts.target),
  listLocalShares: (opts: { target?: string } = {}) => rpc("listLocalShares", opts.target),
  createShare: (body: unknown) => rpc("createLocalShare", body),
  revokeShare: (slug: string) => rpc("revokeLocalShare", slug),
  // Bucket credentials live IN the replica in no-origin mode, so re-signing an
  // s3 share works right here (browser → bucket over the existing CORS path).
  renewShare: (slug: string, opts?: { refreshContent?: boolean }) =>
    rpc("renewLocalShare", slug, opts),
  // Structurally unavailable without an online server: explicit refusals
  // instead of a silent fetch against an origin that doesn't exist.
  publishSite: () =>
    Promise.reject(
      new ApiError("此设备通过同步存储桶交换数据，不支持设备托管发布；请在在线主节点操作", "invalid_input", 400),
    ),
  recoverSitePublish: () =>
    Promise.reject(
      new ApiError("此设备通过同步存储桶交换数据，不支持设备托管发布；请在在线主节点操作", "invalid_input", 400),
    ),
  setSiteHosting: () =>
    Promise.reject(new ApiError("此设备没有可配置的托管入口", "invalid_input", 400)),
  verifySiteHosting: () =>
    Promise.reject(new ApiError("此设备没有可配置的托管入口", "invalid_input", 400)),
};
