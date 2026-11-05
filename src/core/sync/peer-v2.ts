import { writeTx, type DbDriver } from "../driver.ts";
import { historyChangeKey } from "./history-observation.ts";
import type { Change } from "../crdt.ts";
import { ingestDetailed } from "../crdt.ts";
import { MhError } from "../errors.ts";
import { readReplicaGeneration } from "./retention-protocol.ts";
import { ingestV2Batch } from "./v2-ingest.ts";

export function editBases(db: DbDriver, changes: Change[]): (string | null)[] {
  return changes.map(c => {
    const row = db.query("SELECT value FROM meta WHERE key=?").get(`sync_v2_base:${c.hlc}:${c.dataset}:${c.row_id}:${c.col}`) as { value: string } | null;
    return row ? JSON.parse(row.value) : null;
  });
}
/** HTTP cursors acknowledge peer delivery only; they never prove bucket source
 * coverage. Reuse terminal deletion and conflict handling for every ingress. */
export function ingestPeerChanges(db: DbDriver, changes: Change[], bases?: (string | null)[]) {
  const generation = readReplicaGeneration(db);
  if (!generation) return ingestDetailed(db, changes);
  if (!bases || bases.length !== changes.length || bases.some(base => base !== null && typeof base !== "string"))
    throw new MhError("upgrade_required", "v2 peer edit baselines are required");
  return writeTx(db, () => {
    db.exec("CREATE TABLE IF NOT EXISTS sync_v2_peer_pending (id TEXT PRIMARY KEY, change_json TEXT NOT NULL)");
    const unseen = changes.filter(c => !db.query("SELECT 1 FROM crdt_changes WHERE dataset=? AND row_id=? AND col=? AND hlc=?").get(c.dataset,c.row_id,c.col,c.hlc));
    const result = ingestV2Batch(db, { protocolVersion: 2, workspaceId: generation.workspaceId, epoch: generation.epoch,
      member: "http-delivery", first: 1, last: changes.length, changes, bases });
    if (result.poisoned || Object.values(result.skewed).some(n => n > 0))
      throw new MhError("invalid_input", "v2 peer batch was not completely accepted");
    for (const c of unseen) db.query("INSERT OR IGNORE INTO sync_v2_peer_pending(id,change_json) VALUES(?,?)").run(historyChangeKey(c),JSON.stringify(c));
    return result;
  });
}

export function pendingPeerChanges(db: DbDriver): Change[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_v2_peer_pending'").get()) return [];
  return (db.query("SELECT change_json FROM sync_v2_peer_pending ORDER BY id").all() as { change_json: string }[]).map(row => JSON.parse(row.change_json));
}
export function confirmPeerChanges(db: DbDriver, changes: Change[]): void {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_v2_peer_pending'").get()) return;
  for (const c of changes) db.query("DELETE FROM sync_v2_peer_pending WHERE id=?").run(historyChangeKey(c));
}
