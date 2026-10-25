import { queryDocuments, queryRecords, queryRecordsAsync, type RecordQuery } from "../../shared/views/query.ts";
import type { DbDriver } from "../driver.ts";
import * as databases from "../databases.ts";
import * as properties from "../properties.ts";
import * as records from "../records.ts";
import * as documents from "../documents.ts";
import * as history from "../history.ts";
import { search, searchIncrementally } from "../search.ts";
import { lookupCandidates } from "../resolve.ts";
import { displayNodes, getNodeId, setNodeLabel } from "../node.ts";
import { MhError } from "../errors.ts";
import { createDraftStore } from "./drafts.ts";

export interface ReplicaChange {
  datasets: string[];
  rowIds: string[];
  truncated: boolean;
}
export function replicaSequence(db: DbDriver): number {
  return (db.query("SELECT coalesce(max(seq),0) AS seq FROM crdt_changes").get() as { seq: number }).seq;
}
export function replicaChangesSince(db: DbDriver, sequence: number): ReplicaChange | null {
  const rows = db.query("SELECT dataset, row_id FROM crdt_changes WHERE seq > ? ORDER BY seq LIMIT 501").all(sequence) as { dataset: string; row_id: string }[];
  if (!rows.length) return null;
  // Once capped, include every changed dataset even when row ids are truncated.
  const datasets = rows.length > 500
    ? (db.query("SELECT DISTINCT dataset FROM crdt_changes WHERE seq > ?").all(sequence) as { dataset: string }[]).map(r => r.dataset)
    : [...new Set(rows.map(r => r.dataset))];
  return { datasets, rowIds: [...new Set(rows.slice(0, 500).map(r => r.row_id))], truncated: rows.length > 500 };
}

function bind<A extends unknown[], R>(db: DbDriver, fn: (db: DbDriver, ...args: A) => R) {
  return (...args: A): R => fn(db, ...args);
}

/** The same synchronous command owner serves native screens and the editor bridge.
 * Promise facades enter the command before yielding; no CRDT context spans await. */
export function createReplicaService(db: DbDriver, options: { onChange?: (change: ReplicaChange) => void; searchBatchSize?: number } = {}) {
  const searchBatchSize = options.searchBatchSize ?? 200;
  if (!Number.isSafeInteger(searchBatchSize) || searchBatchSize <= 0) throw new RangeError("searchBatchSize must be a positive integer");
  const searches = new AbortController();
  let disposed = false;
  const listeners = new Set<(change: ReplicaChange) => void>();
  if (options.onChange) listeners.add(options.onChange);
  const emit = (change: ReplicaChange) => { for (const listener of listeners) listener(change); };
  const commands = {
    listDatabases: bind(db, databases.listDatabases),
    queryDocuments: (query?: Parameters<typeof queryDocuments>[1]) => queryDocuments(db, query),
    createDatabase: bind(db, databases.createDatabase),
    updateDatabase: bind(db, databases.updateDatabase),
    duplicateDatabase: (id: string, options: Parameters<typeof databases.duplicateDatabase>[2] = {}) => databases.duplicateDatabase(db, id, options),
    deleteDatabase: (id: string) => ({ ok: databases.deleteDatabase(db, id) }),
    listProperties: bind(db, properties.listProperties),
    addProperty: bind(db, properties.addProperty),
    updateProperty: bind(db, properties.updateProperty),
    setPropertyWidth: bind(db, properties.setPropertyWidth),
    removeProperty: (id: string) => ({ ok: properties.removeProperty(db, id) }),
    renameSelectOption: bind(db, properties.renameSelectOption),
    removeSelectOption: bind(db, properties.removeSelectOption),
    listRecords: bind(db, records.listRecords),
    queryRecords: (id: string, query?: RecordQuery) => queryRecords(db, id, query),
    getRecord: (id: string) => {
      const record = records.getRecord(db, id);
      if (!record) throw new MhError("not_found", `no such record: ${id}`);
      return record;
    },
    createRecord: bind(db, records.createRecord),
    updateRecord: bind(db, records.updateRecord),
    moveRecord: bind(db, records.moveRecord),
    deleteRecord: (id: string) => ({ ok: records.deleteRecord(db, id) }),
    listRecordRevisions: bind(db, history.listRecordRevisions),
    recordAtVersion: bind(db, history.recordAtVersion),
    recordFieldHistory: bind(db, history.recordFieldHistory),
    revertRecord: bind(db, history.revertRecord),
    listPropertyRevisions: bind(db, history.listPropertyRevisions),
    propertyAtVersion: bind(db, history.propertyAtVersion),
    revertProperty: bind(db, history.revertProperty),
    listDatabaseActivity: (id: string, limit?: number) => history.listDatabaseActivity(db, id, { limit }),
    listDocuments: bind(db, documents.listDocuments),
    getDocument: (id: string) => {
      const doc = documents.getDocument(db, id);
      if (!doc) throw new MhError("not_found", `no such document: ${id}`);
      return { ...doc, version: documents.documentVersion(db, id) };
    },
    createDocument: (input: Parameters<typeof documents.createDocument>[1]) => {
      const doc = documents.createDocument(db, input);
      return { ...doc, version: documents.documentVersion(db, doc.id) };
    },
    updateDocument: (id: string, fields: Parameters<typeof documents.updateDocument>[2], ifMatch?: string) => {
      const doc = documents.updateDocument(db, id, fields, { ifMatch });
      return { ...doc, version: documents.documentVersion(db, id) };
    },
    moveDocument: bind(db, documents.moveDocument),
    duplicateDocument: (id: string, options?: { title?: string; parent_id?: string | null }) => {
      const doc = documents.duplicateDocument(db, id, { title: options?.title, parentId: options?.parent_id });
      return { ...doc, version: documents.documentVersion(db, doc.id) };
    },
    deleteDocument: (id: string) => ({ ok: documents.deleteDocument(db, id) }),
    listDocumentRevisions: bind(db, history.listDocumentRevisions),
    documentAtVersion: bind(db, history.documentAtVersion),
    revertDocument: (id: string, to: string, ifMatch?: string) => history.revertDocument(db, id, to, { ifMatch }),
    nodes: () => displayNodes(db),
    setNodeLabel: (label: string | null, nodeId?: string) => {
      setNodeLabel(db, label, nodeId);
      return displayNodes(db).find(n => n.node_id === (nodeId ?? getNodeId(db)))!;
    },
    search: (text: string, limit?: number) => search(db, text, { limit, maintainIndex: false }),
    resolve: (text: string, limit?: number) => lookupCandidates(db, text, { limit }),
  };
  type Commands = typeof commands;
  type Operation = keyof Commands;
  function dispatchRpc(op: string, args: unknown[]): unknown {
    if (!Object.hasOwn(commands, op)) throw new MhError("invalid_input", `unknown replica command: ${op}`);
    const before = replicaSequence(db);
    // Functions are all synchronous and typed at the public dispatch boundary.
    const fn = commands[op as Operation] as (...args: unknown[]) => unknown;
    const result = fn(...args);
    const change = replicaChangesSince(db, before);
    if (change) emit(change);
    return result;
  }
  function dispatch<K extends Operation>(op: K, args: Parameters<Commands[K]>): ReturnType<Commands[K]> {
    return dispatchRpc(op, args) as ReturnType<Commands[K]>;
  }
  async function call<K extends Operation>(op: K, ...args: Parameters<Commands[K]>): Promise<ReturnType<Commands[K]>> {
    return dispatch(op, args);
  }
  const client = {
    listDatabases: () => call("listDatabases"),
    queryDocuments: (query?: Parameters<typeof queryDocuments>[1]) => call("queryDocuments", query),
    createDatabase: (...args: Parameters<Commands["createDatabase"]>) => call("createDatabase", ...args),
    updateDatabase: (...args: Parameters<Commands["updateDatabase"]>) => call("updateDatabase", ...args),
    duplicateDatabase: (...args: Parameters<Commands["duplicateDatabase"]>) => call("duplicateDatabase", ...args),
    deleteDatabase: (id: string) => call("deleteDatabase", id),
    listProperties: (id: string) => call("listProperties", id),
    createProperty: (input: Parameters<Commands["addProperty"]>[1] & { db: string }) => {
      const { db: id, ...fields } = input;
      return call("addProperty", id, fields);
    },
    addProperty: (...args: Parameters<Commands["addProperty"]>) => call("addProperty", ...args),
    updateProperty: (...args: Parameters<Commands["updateProperty"]>) => call("updateProperty", ...args),
    deleteProperty: (id: string) => call("removeProperty", id),
    listRecords: (...args: Parameters<Commands["listRecords"]>) => call("listRecords", ...args),
    queryRecords: (id: string, query?: RecordQuery) => queryRecordsAsync(db, id, query, () => !disposed),
    renameSelectOption: (...args: Parameters<Commands["renameSelectOption"]>) => call("renameSelectOption", ...args),
    getRecord: (id: string) => call("getRecord", id),
    createRecord: (...args: Parameters<Commands["createRecord"]>) => call("createRecord", ...args),
    updateRecord: (...args: Parameters<Commands["updateRecord"]>) => call("updateRecord", ...args),
    deleteRecord: (id: string) => call("deleteRecord", id),
    moveRecord: (...args: Parameters<Commands["moveRecord"]>) => call("moveRecord", ...args),
    recordHistory: (id: string) => call("listRecordRevisions", id),
    recordAt: (id: string, version: string) => call("recordAtVersion", id, version),
    revertRecord: (id: string, version: string) => call("revertRecord", id, version),
    listDocuments: (databaseId?: string) => call("listDocuments", databaseId ? { database_id: databaseId } : {}),
    listDocumentsByParent: (parentId: string) => call("listDocuments", { parent_id: parentId }),
    getDocument: (id: string) => call("getDocument", id),
    createDocument: (...args: Parameters<Commands["createDocument"]>) => call("createDocument", ...args),
    updateDocument: (id: string, input: Parameters<Commands["updateDocument"]>[1] & { if_match?: string }) => {
      const { if_match, ...fields } = input;
      return call("updateDocument", id, fields, if_match);
    },
    deleteDocument: (id: string) => call("deleteDocument", id),
    duplicateDocument: (...args: Parameters<Commands["duplicateDocument"]>) => call("duplicateDocument", ...args),
    moveDocument: (...args: Parameters<Commands["moveDocument"]>) => call("moveDocument", ...args),
    documentHistory: (id: string) => call("listDocumentRevisions", id),
    documentAt: (id: string, version: string) => call("documentAtVersion", id, version),
    revertDocument: (id: string, to: string, ifMatch?: string) => call("revertDocument", id, to, ifMatch),
    search: (text: string, limit?: number) => searchIncrementally(db, text, { limit, batchSize: searchBatchSize, signal: searches.signal }),
    resolve: (text: string, limit?: number) => call("resolve", text, limit),
    onUpdate: (listener: (info: { seq?: number; gone?: true }) => void) => {
      const cb = () => listener({ seq: replicaSequence(db) });
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
  return {
    db, commands, dispatch, dispatchRpc, call, client, drafts: createDraftStore(db),
    notifyChanges: emit,
    onChange(listener: (change: ReplicaChange) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() { disposed = true; searches.abort(); listeners.clear(); },
  };
}
export type ReplicaService = ReturnType<typeof createReplicaService>;
export type ReplicaClient = ReplicaService["client"];
