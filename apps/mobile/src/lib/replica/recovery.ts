import { freezeAndFlushEditors } from "../editor/recovery-barrier";
import { backupDatabaseSync, openDatabaseSync } from "expo-sqlite";
import { Directory, File, Paths } from "expo-file-system";
import { ExpoDriver, nativeSqliteOpenOptions } from "./expo-driver";
import { selectMobileReplica } from "./open";
import { initSchema } from "../../../../../src/core/schema-init";
import { recoverV2Workspace, type RecoveryPhase } from "../../../../../src/core/sync/recovery-v2";
import { storageUrl } from "../../../../../src/core/sync/storage-url";
import { storageClientFor, type StorageClient } from "../../../../../src/core/sync/storage";
import { commitHash } from "../../../../../src/core/sync/commit-log";
import { createAttachmentStore, type AttachmentTransfer } from "../attachments/store";
import { hashFile } from "../attachments/native";
import type { Session } from "../auth/session";

const rebuilding = new WeakSet<Session>();

/** Native recovery uses SQLite's online backup, never copies an open WAL file.
 * The active filename is one atomic SQLite row; a crash sees old or new DB. */
export async function recoverMobileWorkspace(session: Session, reload: () => Promise<void>, phase: (value: RecoveryPhase) => void, client?: StorageClient) {
  if (rebuilding.has(session)) throw new Error("本地副本正在升级");
  rebuilding.add(session);
  try {
    return await rebuild(session, reload, phase, client);
  } finally {
    rebuilding.delete(session);
  }
}

async function rebuild(session: Session, reload: () => Promise<void>, phase: (value: RecoveryPhase) => void, client?: StorageClient) {
  if (!session.creds.bucket) throw new Error("此工作区未连接存储桶");
  const config = session.creds.bucket;
  let shadowSqlite: ReturnType<typeof openDatabaseSync> | null = null;
  let shadowName = "";
  let releaseEditors = () => {};
  const protectedTransfers: AttachmentTransfer[] = [];
  const protectedAttachments: ReturnType<typeof createAttachmentStore>["list"] extends () => infer R ? R : never = [];
  return recoverV2Workspace(session.replica.db, client ?? storageClientFor(config), config, session.workspaceId, {
    legacyPeerUrl: storageUrl(config.endpoint, config.bucket, config.prefix),
    phase,
    async pauseAndFlush() {
      await session.sync.stop();
      releaseEditors = await freezeAndFlushEditors(session.replica);
      session.replica.service.pauseMutations(true);
      // Input is frozen and every mounted editor bridge has acknowledged its
      // flush before database and attachment protection begins.
      await session.attachments.quiesce();
    },
    async protect(id) {
      if (!session.isCurrent()) throw new Error("工作区已切换");
      const directory = new Directory(Paths.document, "recovery", id);
      directory.create({ intermediates: true, idempotent: true });
      const backup = openDatabaseSync(`metahub-protection-${id}.db`, nativeSqliteOpenOptions);
      try {
        backupDatabaseSync({ sourceDatabase: session.replica.sqlite, destDatabase: backup });
        if (backup.getFirstSync<{ quick_check: string }>("PRAGMA quick_check")?.quick_check !== "ok") throw new Error("保护副本校验失败");
        const manifest: { uri: string; hash: string; size: number }[] = [];
        const sourceStore = createAttachmentStore(session.replica.db);
        for (const entry of sourceStore.list()) {
          const file = new File(entry.uri);
          if (!file.exists) { if (entry.pending) throw new Error(`未上传附件缺失：${entry.name}`); continue; }
          const target = new File(directory, entry.hash);
          if (!target.exists) await file.copy(target);
          if (await hashFile(target, () => { if (!session.isCurrent()) throw new Error("工作区已切换"); }) !== entry.hash)
            throw new Error(`附件保护副本校验失败：${entry.name}`);
          manifest.push({ uri: target.uri, hash: entry.hash, size: target.size });
          protectedAttachments.push({ ...entry, pinned: 1 });
        }
        for (const transfer of sourceStore.transfers()) {
          const file = new File(transfer.tempUri);
          if (!file.exists) {
            if (transfer.entry?.pending && !new File(transfer.entry.uri).exists) throw new Error("未上传附件临时文件缺失，已停止更新本地副本");
            if (transfer.entry) {
              const canonical = new File(transfer.entry.uri);
              if (canonical.exists && await hashFile(canonical, () => {}) !== transfer.entry.hash) throw new Error("附件恢复日志校验失败");
              protectedAttachments.push({ ...transfer.entry, pinned: 1 });
            }
            continue;
          }
          const target = new File(directory, `transfer-${protectedTransfers.length}`);
          if (!target.exists) await file.copy(target);
          const digest = await hashFile(file, () => {});
          if (transfer.entry && digest !== transfer.entry.hash) throw new Error("附件临时文件与恢复日志不一致");
          if (await hashFile(target, () => {}) !== digest) throw new Error("附件临时文件保护失败");
          manifest.push({ uri: target.uri, hash: digest, size: target.size });
          protectedTransfers.push(transfer);
        }
        const content = JSON.stringify({ database: `metahub-protection-${id}.db`, attachments: manifest });
        const file = new File(directory, "manifest.json");
        file.write(content);
        if (await file.text() !== content) throw new Error("保护清单写入失败");
        return { proof: await commitHash(new TextEncoder().encode(content)) };
      } finally { backup.closeSync(); }
    },
    async createShadow(id) {
      shadowName = `metahub-recovered-${id}.db`;
      shadowSqlite = openDatabaseSync(shadowName, nativeSqliteOpenOptions);
      const driver = new ExpoDriver(shadowSqlite);
      initSchema(driver);
      const store = createAttachmentStore(driver);
      for (const entry of protectedAttachments) store.put(entry);
      for (const transfer of protectedTransfers) store.journal(transfer);
      return driver;
    },
    async swap() {
      if (!session.isCurrent()) throw new Error("工作区已切换，原数据库保留");
      selectMobileReplica(session.workspaceId, shadowName);
    },
    async releaseShadow() { shadowSqlite?.closeSync(); shadowSqlite = null; },
    async resume() {
      // Reopen through the atomic pointer on both success and failure; this also
      // reinstates attachment transfer ownership after cancellation.
      try {
        if (session.isCurrent()) await reload();
      } finally {
        if (session.isCurrent()) session.replica.service.pauseMutations(false);
        releaseEditors();
      }
    },
  });
}
