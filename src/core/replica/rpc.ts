import type { ReplicaService } from "./service.ts";

/** Core CRUD operations shared by the browser worker and native owner. Runtime
 * transports, attachments and hosted sites stay in their own adapters. */
export const REPLICA_RPC_OPERATIONS = [
  "listDatabases", "createDatabase", "updateDatabase", "duplicateDatabase", "deleteDatabase", "listDatabaseActivity",
  "listProperties", "addProperty", "updateProperty", "setPropertyWidth", "removeProperty", "renameSelectOption", "removeSelectOption", "listPropertyRevisions", "revertProperty",
  "listRecords", "getRecord", "createRecord", "updateRecord", "moveRecord", "deleteRecord", "listRecordRevisions", "recordAtVersion", "recordFieldHistory", "revertRecord",
  "listDocuments", "getDocument", "createDocument", "updateDocument", "duplicateDocument", "moveDocument", "deleteDocument", "listDocumentRevisions", "documentAtVersion", "revertDocument",
  "nodes", "setNodeLabel", "resolve",
] as const satisfies readonly (keyof ReplicaService["commands"])[];

/** Preserve the browser worker's RPC response shapes while sharing command
 * validation, synchronous transactions, and changes with the native replica. */
export function replicaRpcOps(resolve: () => ReplicaService): Record<string, (...args: any[]) => unknown> {
  const ops: Record<string, (...args: any[]) => unknown> = {};
  for (const operation of REPLICA_RPC_OPERATIONS)
    ops[operation] = (...args: unknown[]) => resolve().dispatchRpc(operation, args);
  // Browser createDocument historically returns the materialized row; its GET
  // and UPDATE include a version. Native's client facade includes it on create.
  ops.createDocument = (...args: unknown[]) => {
    const { version: _version, ...row } = resolve().dispatchRpc("createDocument", args) as ReturnType<ReplicaService["commands"]["createDocument"]>;
    return row;
  };
  return ops;
}
