import { writeTx, type DbDriver } from "../driver.ts";
import { MhError } from "../errors.ts";
import { addPeer, addStoragePeer, getPeer, listPeers } from "./peers.ts";
import { loadV2DocumentHistory } from "./recovery-v2.ts";
import { createV2Bucket } from "./bucket-v2.ts";
import { knownDataVersion } from "./data-version.ts";
import { storageClientFor } from "./storage.ts";
import { needsBucketUpgrade, readReplicaGeneration } from "./retention-protocol.ts";
import { workspaceAccess, requiresWorkspaceConfirmation } from "./workspace-access.ts";

const pointer = "local_recovery_successor";
export const replicaName = (id: string) => `replica-${id}.db`;

function validName(name: string) {
  if (!/^replica-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.db$/.test(name))
    throw new MhError("invalid_input", "Invalid local replica pointer");
  return name;
}

/** Each retired database contains one durable link. A missing target is an
 * error: opening an empty replacement would hide the verified replica. */
export function openActiveReplica<T extends { db: DbDriver; close(): void }>(
  open: (name: string, initial: boolean) => T,
): T {
  let name = "metahub.db";
  const visited = new Set<string>();
  for (;;) {
    if (visited.has(name))
      throw new MhError("invalid_input", "Local replica pointer cycle");
    visited.add(name);
    const handle = open(name, visited.size === 1);
    try {
      if (
        !handle.db
          .query(
            "SELECT 1 FROM sqlite_master WHERE name='meta' AND type='table'",
          )
          .get()
      ) {
        if (visited.size !== 1)
          throw new MhError("invalid_input", "Local replacement is incomplete");
        return handle;
      }
      const row = handle.db
        .query("SELECT value FROM meta WHERE key=?")
        .get(pointer) as { value: string } | null;
      if (!row) return handle;
      name = validName(row.value);
    } catch (error) {
      handle.close();
      throw error;
    }
    handle.close();
  }
}

export function publishSuccessor(source: DbDriver, name: string) {
  validName(name);
  writeTx(source, () => {
    source.query("INSERT INTO meta(key,value) VALUES(?,?)").run(pointer, name);
    // An already-open CLI or sidecar must reopen before making another CRDT write.
    source.exec(
      "CREATE TRIGGER retired_replica BEFORE INSERT ON crdt_changes BEGIN SELECT RAISE(ABORT,'local replica was rebuilt; reopen it'); END",
    );
  });
}

/** Foreground check also works when the sync scheduler is paused/offline. */
export async function inspectWorkspaceVersion(db: DbDriver) {
  const bound = db.query("SELECT value FROM meta WHERE key='local_v2_history_peer'").get() as { value: string } | null;
  const peers = listPeers(db).filter(p => p.enabled && p.kind === "s3" && p.config);
  const peer = bound ? peers.find(p => p.url === bound.value) : peers.length === 1 ? peers[0] : undefined;
  if (peer?.config) {
    try {
      const config = JSON.parse(peer.config);
      const bucket = createV2Bucket(storageClientFor(config, { signal: AbortSignal.timeout(8000) }), config, db);
      const root = await bucket.root();
      if (root) await bucket.log(root).read();
    } catch {
      // Keep the last verified observation. Normal sync reports network or
      // identity errors; a failed probe cannot authorize a version change.
    }
  }
  return knownDataVersion(db)?.dataVersion ?? 2;
}

export function upgradeBuckets(db: DbDriver): string[] {
  const states = workspaceAccess(db);
  return listPeers(db).filter(p => p.enabled && (states.some(s => s.url === p.url && requiresWorkspaceConfirmation(s)) ||
    (p.kind === "s3" && p.config && needsBucketUpgrade(db, p.url)))).map(p => p.url);
}

export async function inspectConnectedWorkspaceAccess(db: DbDriver) {
  const { inspectWorkspaceAccess, connectedWorkspaceTarget } = await import("./workspace-recovery.ts");
  for (const peer of listPeers(db).filter(p => p.enabled && (p.kind === "http" || p.kind === "s3" && p.config)))
    await inspectWorkspaceAccess(db, connectedWorkspaceTarget(db, peer.url));
  return workspaceAccess(db).filter(state => listPeers(db).some(p => p.enabled && p.url === state.url));
}

export function localRecoveryTarget(db: DbDriver, url: string) {
  const peer = listPeers(db).find(
    (row) => row.url === url && row.enabled && row.kind === "s3" && row.config,
  );
  if (!peer?.config)
    throw new MhError(
      "invalid_input",
      "Select a connected bucket on this device",
    );
  return {
    config: JSON.parse(peer.config),
    workspaceId: readReplicaGeneration(db)?.workspaceId ?? crypto.randomUUID(),
  };
}

/** Hydrate retained revisions only when an operation actually needs history. */
export async function hydrateLocalHistory(db: DbDriver, docId: string) {
  const checkpoint = db
    .query("SELECT value FROM meta WHERE key='sync_v2_checkpoint'")
    .get() as { value: string } | null;
  if (!checkpoint) return;
  const refs = (JSON.parse(checkpoint.value).history ?? []) as {
    documentId: string;
    hash: string;
  }[];
  if (
    !refs.some(
      (ref) =>
        ref.documentId === docId &&
        !db
          .query("SELECT 1 FROM meta WHERE key=?")
          .get(`sync_v2_history_loaded:${ref.hash}`),
    )
  )
    return;
  const bound = db
    .query("SELECT value FROM meta WHERE key='local_v2_history_peer'")
    .get() as { value: string } | null;
  const peer = bound && getPeer(db, bound.value);
  if (!peer?.enabled || !peer.config)
    throw new MhError("history_unavailable", "历史尚未下载，请连接原存储桶");
  const config = JSON.parse(peer.config);
  await loadV2DocumentHistory(db, storageClientFor(config), config, docId);
}

/** Preserve connection settings, never the old transport acknowledgements. */
export function installLocalConnections(
  source: DbDriver,
  shadow: DbDriver,
  recoveryPeer: string,
) {
  // These credentials/settings belong to this machine, never to the downloaded
  // workspace. Retain them across a host-controlled database pointer swap.
  for (const row of source.query("SELECT key,value FROM meta WHERE substr(key,1,4)='cfg_' OR key IN ('auth_token','auth_token_exp','auth_token_prev','auth_token_prev_exp','node_id')").all() as { key: string; value: string }[])
    shadow.query("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(row.key, row.value);
  for (const row of source.query("SELECT token,peer_url,node_id,created_at FROM peer_grants").all() as { token: string; peer_url: string | null; node_id: string | null; created_at: number | null }[])
    shadow.query("INSERT OR REPLACE INTO peer_grants(token,peer_url,node_id,created_at) VALUES(?,?,?,?)").run(row.token, row.peer_url, row.node_id, row.created_at);
  if (getPeer(source, recoveryPeer)?.kind === "s3") shadow
    .query("INSERT INTO meta(key,value) VALUES('local_v2_history_peer',?)").run(recoveryPeer);
  for (const peer of listPeers(source)) {
    if (peer.kind === "s3" && peer.config)
      addStoragePeer(shadow, {
        url: peer.url,
        label: peer.label,
        config: JSON.parse(peer.config),
      });
    else if (peer.kind === "http")
      addPeer(shadow, {
        url: peer.url,
        label: peer.label,
        token: peer.token,
        node_id: peer.node_id,
      });
    else {
      shadow
        .query(
          "INSERT INTO peers(url,kind,config,label,token,node_id) VALUES(?,?,?,?,?,?)",
        )
        .run(
          peer.url,
          peer.kind,
          peer.config,
          peer.label,
          peer.token,
          peer.node_id,
        );
    }
    shadow
      .query("UPDATE peers SET enabled=? WHERE url=?")
      .run(peer.enabled, peer.url);
  }
}
