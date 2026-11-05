import { initSchema } from "../../core/schema-init.ts";
import type { DbDriver } from "../../core/driver.ts";
import {
  recoverV2Workspace,
  type RecoveryPhase,
} from "../../core/sync/recovery-v2.ts";
import {
  installLocalConnections,
  localRecoveryTarget,
  publishSuccessor,
  replicaName,
} from "../../core/sync/recovery-local.ts";
import {
  storageClientFor,
  type StorageClient,
} from "../../core/sync/storage.ts";
import { commitHash } from "../../core/sync/commit-log.ts";
import { spoolPending, verifyBytes, type SpoolBlob } from "./blob-store.ts";

export interface BrowserDatabase {
  db: DbDriver;
  close(): void;
}
export interface BrowserRecoveryFiles {
  reserve(): Promise<void>;
  open(name: string): BrowserDatabase;
  bytes(name: string): Promise<Uint8Array>;
  activate(handle: BrowserDatabase): void;
}

export async function rebuildBrowserReplica(
  source: DbDriver,
  url: string,
  files: BrowserRecoveryFiles,
  phase: (state: RecoveryPhase) => void,
  transport?: StorageClient,
  attachments: () => Promise<SpoolBlob[]> = spoolPending,
) {
  const { config, workspaceId } = localRecoveryTarget(source, url);
  let replacement: BrowserDatabase | undefined;
  return recoverV2Workspace(
    source,
    transport ?? storageClientFor(config),
    config,
    workspaceId,
    {
      legacyPeerUrl: url,
      phase,
      async pauseAndFlush() {
        await files.reserve();
        source.exec("PRAGMA synchronous=FULL");
      },
      async protect(id) {
        // VACUUM INTO takes a consistent SQLite snapshot including committed WAL pages.
        const name = `protection-${id}.db`;
        source.query("VACUUM INTO ?").run("/" + name);
        const protection = files.open(name);
        try {
          protection.db.exec(
            "CREATE TABLE protected_spool(hash TEXT PRIMARY KEY, content_type TEXT NOT NULL, bytes BLOB NOT NULL)",
          );
          for (const blob of await attachments()) {
            if (
              !/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(blob.hash) ||
              !(await verifyBytes(blob.bytes, blob.hash))
            )
              throw new Error("待上传附件校验失败");
            protection.db
              .query("INSERT INTO protected_spool VALUES(?,?,?)")
              .run(blob.hash, blob.content_type, new Uint8Array(blob.bytes));
            const saved = protection.db
              .query("SELECT bytes FROM protected_spool WHERE hash=?")
              .get(blob.hash) as { bytes: Uint8Array };
            if (!(await verifyBytes(saved.bytes, blob.hash)))
              throw new Error("附件保护副本校验失败");
          }
          if (
            (
              protection.db.query("PRAGMA quick_check").get() as {
                quick_check: string;
              }
            ).quick_check !== "ok"
          )
            throw new Error("数据库保护副本校验失败");
        } finally {
          protection.close();
        }
        return { proof: await commitHash(await files.bytes(name)) };
      },
      async createShadow(id) {
        replacement = files.open(replicaName(id));
        try {
          replacement.db.exec("PRAGMA synchronous=FULL");
          initSchema(replacement.db);
          installLocalConnections(source, replacement.db, url);
          return replacement.db;
        } catch (error) {
          replacement.close();
          throw error;
        }
      },
      async swap(_, id) {
        publishSuccessor(source, replicaName(id));
        files.activate(replacement!);
      },
      async releaseShadow(_, committed) {
        if (!committed) replacement?.close();
      },
      async resume() {},
    },
  );
}
