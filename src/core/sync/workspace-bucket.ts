import type { DbDriver } from "../driver.ts";
import { MhError } from "../errors.ts";
import { createV2Bucket } from "./bucket-v2.ts";
import { knownDataVersion } from "./data-version.ts";
import { readReplicaGeneration } from "./retention-protocol.ts";
import { storageBasePrefix, type StorageClient, type S3Config } from "./storage.ts";
import { classifyWorkspaceAccess, setWorkspaceAccess, workspaceAccessError, type WorkspaceAccess } from "./workspace-access.ts";

/** Inspection never publishes a root or writes a legacy segment. A successful
 * absence check, rather than a failed GET, authorizes creating a new workspace. */
export async function inspectBucketAccess(db: DbDriver, url: string, client: StorageClient, config: S3Config): Promise<WorkspaceAccess> {
  setWorkspaceAccess(db, { url, kind: "checking" });
  try {
    const bucket = createV2Bucket(client, config, db), root = await bucket.root();
    if (root) {
      const head = await bucket.log(root).read();
      return setWorkspaceAccess(db, classifyWorkspaceAccess(db, url, {
        protocolVersion: 2, workspaceId: root.workspaceId, epoch: head.state.epoch,
        checkpoint: head.state.checkpoint, incarnationId: "inspection",
      }, head.state.dataVersion, "bucket"));
    }
    if (knownDataVersion(db) || readReplicaGeneration(db))
      throw new MhError("busy", "已连接工作区的同步根记录不可用，请重试");
    const base = storageBasePrefix(config.prefix);
    const [control, ...legacy] = await Promise.all(["v2/control/", "oplog/", "snapshot/", "publisher/"].map(path => client.list(`${base}/${path}`)));
    if (control!.length) throw new MhError("busy", "工作区控制日志存在，但根记录不可用");
    if (legacy.some(objects => objects.length)) return setWorkspaceAccess(db, { url, kind: "migration", reason: "legacy-layout", dataVersion: 1 });
    if (db.query("SELECT 1 FROM peers WHERE url=? AND last_success_at IS NOT NULL").get(url))
      throw new MhError("busy", "此前已连接的工作区数据不可用，请重试");
    if (db.query("SELECT 1 FROM peers WHERE last_success_at IS NOT NULL LIMIT 1").get())
      return setWorkspaceAccess(db, { url, kind: "migration", reason: "本地已有同步绑定，请确认后建立新版同步", dataVersion: 2 });
    // Recheck after LIST, which may have raced another initializer.
    const winner = await bucket.root();
    if (winner) {
      const head = await bucket.log(winner).read();
      return setWorkspaceAccess(db, classifyWorkspaceAccess(db, url, { protocolVersion: 2, workspaceId: winner.workspaceId,
        epoch: head.state.epoch, checkpoint: head.state.checkpoint, incarnationId: "inspection" }, head.state.dataVersion, "bucket"));
    }
    return setWorkspaceAccess(db, { url, kind: "initializing", reason: "empty-bucket", dataVersion: 2 });
  } catch (error) { return workspaceAccessError(db, url, error); }
}
