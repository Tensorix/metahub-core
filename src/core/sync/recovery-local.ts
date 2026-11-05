import { writeTx, type DbDriver } from "../driver.ts";
import { MhError } from "../errors.ts";
import { addPeer, addStoragePeer, getPeer, listPeers } from "./peers.ts";
import { loadV2DocumentHistory } from "./recovery-v2.ts";
import { storageClientFor } from "./storage.ts";
import { readReplicaGeneration } from "./retention-protocol.ts";

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
  shadow
    .query("INSERT INTO meta(key,value) VALUES('local_v2_history_peer',?)")
    .run(recoveryPeer);
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
