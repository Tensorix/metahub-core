import type { DbDriver } from "../driver.ts";
import { SYNCED_TABLES } from "../tables.ts";
import { getNodeId } from "../node.ts";
import { errorCode, MhError } from "../errors.ts";
import { dataVersionRange, knownDataVersion } from "./data-version.ts";
import { readReplicaGeneration, type ReplicaGeneration } from "./retention-protocol.ts";

export type WorkspaceAccessKind = "checking" | "initializing" | "ready" | "migration" | "rebuild" | "client-update" | "error";
export interface WorkspaceAccess {
  url: string;
  kind: WorkspaceAccessKind;
  reason?: string;
  dataVersion?: number;
}
const prefix = "sync_workspace_access:";
export function setWorkspaceAccess(db: DbDriver, state: WorkspaceAccess) {
  db.query("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(prefix + state.url, JSON.stringify(state));
  return state;
}
export function workspaceAccess(db: DbDriver): WorkspaceAccess[] {
  return (db.query("SELECT value FROM meta WHERE key LIKE ? ORDER BY key").all(prefix + "%") as { value: string }[]).map(row => JSON.parse(row.value));
}
export function workspaceAccessError(db: DbDriver, url: string, error: unknown) {
  return setWorkspaceAccess(db, { url, kind: errorCode(error) === "client_update_required" ? "client-update" : "error",
    dataVersion: knownDataVersion(db)?.dataVersion, reason: error instanceof Error ? error.message : String(error) });
}
function hasRows(db: DbDriver, table: string) {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) && !!db.query(`SELECT 1 FROM ${table} LIMIT 1`).get();
}
/** A missing generation is not evidence of an empty replica. Include tombstones,
 * unpublished attachments and drafts, including tables introduced by adapters. */
export function canAutoJoinWorkspace(db: DbDriver): boolean {
  if (readReplicaGeneration(db)) return false;
  if (db.query("SELECT 1 FROM peers WHERE last_success_at IS NOT NULL OR pull_cursor>0 OR push_cursor>0 LIMIT 1").get()) return false;
  if (db.query("SELECT 1 FROM meta WHERE key LIKE 'sync_verified_peer:%' OR key='local_v2_history_peer' LIMIT 1").get()) return false;
  if (db.query("SELECT 1 FROM crdt_changes WHERE dataset<>'nodes' OR row_id<>? LIMIT 1").get(getNodeId(db))) return false;
  for (const table of SYNCED_TABLES) if (table !== "nodes" && hasRows(db, table)) return false;
  for (const table of ["replica_document_drafts", "replica_field_drafts", "sync_version_drafts", "sync_recovery_items", "sync_recovery_packages", "mobile_attachments", "mobile_attachment_transfers", "blob_cache"])
    if (hasRows(db, table)) return false;
  return true;
}
export function requiresWorkspaceConfirmation(state: WorkspaceAccess) {
  return state.kind === "migration" || state.kind === "rebuild";
}
export function classifyWorkspaceAccess(db: DbDriver, url: string, remote: ReplicaGeneration, dataVersion: number, transport: "http" | "bucket"): WorkspaceAccess {
  const known = knownDataVersion(db), local = readReplicaGeneration(db);
  if ((known && known.workspaceId !== remote.workspaceId) || (local && local.workspaceId !== remote.workspaceId))
    throw new MhError("conflict", "此连接属于另一个工作区，不能自动合并");
  if (dataVersion > dataVersionRange.maxSupportedDataVersion) return { url, kind: "client-update", dataVersion };
  if (!local) return { url, kind: canAutoJoinWorkspace(db) ? "initializing" : "migration", dataVersion };
  if (local.epoch !== remote.epoch || local.checkpoint !== remote.checkpoint) return { url, kind: "rebuild", dataVersion };
  if (transport === "bucket" && db.query("SELECT 1 FROM meta WHERE key='sync_v2_baseline_http'").get())
    return { url, kind: "rebuild", dataVersion, reason: "需要安装存储桶检查点" };
  return { url, kind: "ready", dataVersion };
}
