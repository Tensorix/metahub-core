import type { DbDriver } from "../driver.ts";
import { MhError } from "../errors.ts";
import { beginVersionCheck, requireSupportedVersion } from "./data-version.ts";
import { storageClientFor, type StorageClient, type S3Config } from "./storage.ts";
import { inspectBucketAccess } from "./workspace-bucket.ts";
import { inspectHttpAccess, recoverHttpWorkspace, type HttpWorkspaceTarget } from "./http-bootstrap.ts";
import { recoverV2Workspace, type RecoveryAdapter } from "./recovery-v2.ts";
import { canAutoJoinWorkspace, setWorkspaceAccess, workspaceAccessError, type WorkspaceAccess } from "./workspace-access.ts";
import { readReplicaGeneration } from "./retention-protocol.ts";

export type WorkspaceTarget = { kind: "s3"; url: string; config: S3Config; client?: StorageClient } | ({ kind: "http" } & HttpWorkspaceTarget);
export function connectedWorkspaceTarget(db: DbDriver, url: string, client?: StorageClient): WorkspaceTarget {
  const peer = db.query("SELECT kind,config,token FROM peers WHERE url=? AND enabled=1").get(url) as { kind: string; config: string | null; token: string | null } | null;
  if (peer?.kind === "s3" && peer.config) return { kind: "s3", url, config: JSON.parse(peer.config), client };
  if (peer?.kind === "http") return { kind: "http", url, token: peer.token };
  throw new MhError("invalid_input", "请选择此设备已连接的工作区");
}
export function inspectWorkspaceAccess(db: DbDriver, target: WorkspaceTarget): Promise<WorkspaceAccess> {
  return target.kind === "s3" ? inspectBucketAccess(db, target.url, target.client ?? storageClientFor(target.config), target.config) : inspectHttpAccess(db, target);
}
/** Called by a runtime owner, never by an ordinary push/pull operation. */
export async function recoverConnectedWorkspace(db: DbDriver, target: WorkspaceTarget, adapter: RecoveryAdapter, automatic = false) {
  beginVersionCheck(db, target.url);
  const access = await inspectWorkspaceAccess(db, target);
  requireSupportedVersion(access.dataVersion ?? 2);
  if (access.kind === "error" || access.kind === "checking") throw new MhError("busy", access.reason ?? "工作区连接尚未确认，请重试");
  if (automatic && access.kind !== "initializing") throw new MhError("busy", "此副本需要确认后更新");
  if (automatic && db.query("SELECT 1 FROM peers WHERE enabled=1 AND kind IN ('s3','http') AND url<>? LIMIT 1").get(target.url))
    throw new MhError("busy", "此副本连接了多个同步来源，请先保留一个已确认的工作区连接再重试");
  if (automatic) db.query("INSERT OR REPLACE INTO meta(key,value) VALUES('sync_workspace_initializing',?)").run(target.url);
  let resumeRequested = false;
  const owned: RecoveryAdapter = { ...adapter,
    // The host may close the source while reopening the active replica. Finish
    // source bookkeeping before handing ownership back to that host.
    async resume() { resumeRequested = true; },
    validateSource() {
      adapter.validateSource?.();
      if (automatic && access.reason !== "empty-bucket" && !canAutoJoinWorkspace(db))
        throw new MhError("busy", "本机已有内容，请确认后保全编辑并更新本地副本");
    },
    async swap(shadow, id) {
      setWorkspaceAccess(shadow, { url: target.url, kind: "ready", dataVersion: access.dataVersion ?? 2 });
      shadow.query("INSERT OR REPLACE INTO meta(key,value) VALUES(?, '1')").run(`sync_verified_peer:${target.url}`);
      await adapter.swap(shadow, id);
    },
  };
  try {
    if (target.kind === "http") return await recoverHttpWorkspace(db, target, owned);
    return await recoverV2Workspace(db, target.client ?? storageClientFor(target.config), target.config,
      readReplicaGeneration(db)?.workspaceId ?? crypto.randomUUID(), { ...owned, legacyPeerUrl: target.url });
  } catch (error) { workspaceAccessError(db, target.url, error); throw error; }
  finally {
    try {
      if (automatic) db.query("DELETE FROM meta WHERE key='sync_workspace_initializing' AND value=?").run(target.url);
    } finally {
      if (resumeRequested) await adapter.resume();
    }
  }
}
