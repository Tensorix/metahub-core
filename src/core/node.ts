import type { DbDriver } from "./driver.ts";
import { randomSuffix } from "./ids.ts";

/** Stable per-machine node id, persisted in the meta table. */
export function getNodeId(db: DbDriver): string {
  const row = db
    .query("SELECT value FROM meta WHERE key = 'node_id'")
    .get() as { value: string } | null;
  if (row) return row.value;
  const id = randomSuffix(8);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return id;
}

/** Optional human label for THIS device (meta table, node-local — peers keep
 *  their own labels for us in their peers.label). Null when never set. */
export function getNodeLabel(db: DbDriver): string | null {
  const row = db
    .query("SELECT value FROM meta WHERE key = 'node_label'")
    .get() as { value: string } | null;
  return row?.value ?? null;
}

export function setNodeLabel(db: DbDriver, label: string | null): void {
  if (label == null || label.trim() === "") {
    db.query("DELETE FROM meta WHERE key = 'node_label'").run();
    return;
  }
  db.query(
    "INSERT INTO meta (key, value) VALUES ('node_label', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(label.trim());
}

export interface NodeInfo {
  node_id: string;
  label: string | null;
  self: boolean;
}

/** Display roster: this device (with its own label) plus paired peers with the
 *  labels we gave them. Shared by GET /api/nodes and the replica's `nodes` op
 *  so the two can't drift. */
export function displayNodes(db: DbDriver): NodeInfo[] {
  const self = getNodeId(db);
  const peers = db
    .query(
      "SELECT node_id, label FROM peers WHERE node_id IS NOT NULL AND node_id <> '' GROUP BY node_id",
    )
    .all() as { node_id: string; label: string | null }[];
  return [
    { node_id: self, label: getNodeLabel(db), self: true },
    ...peers.filter((p) => p.node_id !== self).map((p) => ({ ...p, self: false })),
  ];
}
