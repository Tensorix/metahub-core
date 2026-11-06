import { Database } from "bun:sqlite";
import { mkdir, readdir, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { openMetahub } from "../db.ts";
import { initSchema } from "../schema-init.ts";
import { cacheDir, metahubHome } from "../paths.ts";
import { sha256Hex, verifyBlobBytes } from "../cache.ts";
import { recoverConnectedWorkspace, connectedWorkspaceTarget } from "./workspace-recovery.ts";
import { inspectWorkspaceAccess } from "./workspace-recovery.ts";
import { listPeers } from "./peers.ts";
import { readReplicaGeneration } from "./retention-protocol.ts";
import {
  installLocalConnections,
  localRecoveryTarget,
  publishSuccessor,
  replicaName,
} from "./recovery-local.ts";
import { storageClientFor, type StorageClient } from "./storage.ts";

/** Headless/CLI owner: retire the old handle only after a verified pointer swap.
 * With no explicit target, never elect an authority among multiple connections. */
export async function prepareDesktopWorkspace(db: Database, url?: string) {
  if (readReplicaGeneration(db)) return db;
  const peers = listPeers(db).filter(p => p.enabled && (p.kind === "http" || p.kind === "s3" && p.config));
  const selected = url ? peers.find(p => p.url === url) : peers.length === 1 ? peers[0] : undefined;
  if (!selected) return db;
  const state = await inspectWorkspaceAccess(db, connectedWorkspaceTarget(db, selected.url));
  if (state.kind !== "initializing") return db;
  const home = dirname(db.filename);
  await rebuildDesktopReplica(selected.url, undefined, true, db);
  db.close();
  return openMetahub(home);
}

export async function rebuildDesktopReplica(
  url: string,
  transport?: StorageClient,
  automatic = false,
  sourceDb?: Database,
) {
  const source = sourceDb ?? openMetahub();
  const home = dirname(source.filename);
  let shadow: Database | undefined;
  try {
    const target = connectedWorkspaceTarget(source, url, transport);
    return await recoverConnectedWorkspace(
      source, target,
      {
        legacyPeerUrl: url,
        async pauseAndFlush() {
          // The desktop shell has flushed its renderers and stopped its sidecar.
          // Keep other local writers out until the pointer commits or rolls back.
          source.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
          if (source.query("SELECT 1 FROM meta WHERE key=?").get("local_recovery_successor"))
            throw new Error("本地副本已切换，请重新打开");
        },
        async protect(id) {
          const directory = join(home, "recovery", id);
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const path = join(directory, "original.db");
          const reader = new Database(source.filename, { readonly: true });
          try {
            reader.query("VACUUM INTO ?").run(path);
          } finally {
            reader.close();
          }
          await chmod(path, 0o600);
          const hash = sha256Hex(await Bun.file(path).bytes());
          const backup = new Database(path, { readonly: true });
          try {
            if (
              (
                backup.query("PRAGMA quick_check").get() as {
                  quick_check: string;
                }
              ).quick_check !== "ok"
            )
              throw new Error(
                "Database protection copy failed integrity check",
              );
          } finally {
            backup.close();
          }
          const attachments: string[] = [];
          for (const entry of await readdir(join(home, "cache"), {
            withFileTypes: true,
          })) {
            if (!/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(entry.name)) continue;
            if (!entry.isFile())
              throw new Error("Invalid local attachment file");
            const copy = join(directory, entry.name);
            await Bun.write(copy, Bun.file(join(home, "cache", entry.name)));
            if (!verifyBlobBytes(await Bun.file(copy).bytes(), entry.name))
              throw new Error("Attachment protection copy failed verification");
            attachments.push(entry.name);
          }
          const manifest = JSON.stringify({
            database: hash,
            attachments: attachments.sort(),
          });
          const file = Bun.file(join(directory, "manifest.json"));
          await Bun.write(file, manifest);
          if ((await file.text()) !== manifest)
            throw new Error("Recovery manifest verification failed");
          return { proof: sha256Hex(new TextEncoder().encode(manifest)) };
        },
        async createShadow(id) {
          shadow = new Database(join(home, replicaName(id)), {
            create: true,
          });
          await chmod(shadow.filename,0o600);
          shadow.exec("PRAGMA synchronous=FULL");
          initSchema(shadow);
          installLocalConnections(source, shadow, url);
          return shadow;
        },
        async swap(_, id) {
          publishSuccessor(source, replicaName(id));
          source.exec("COMMIT");
        },
        async releaseShadow() {
          shadow?.close();
          shadow = undefined;
        },
        async resume() {
          if (source.inTransaction) source.exec("ROLLBACK");
        },
      }, automatic,
    );
  } finally {
    shadow?.close();
    if (!sourceDb) source.close();
  }
}
