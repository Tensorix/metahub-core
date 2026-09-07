import type { DbDriver } from "./driver.ts";
import { randomSuffix } from "./ids.ts";
import { emit, withChangeGroup } from "./crdt.ts";

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

// ---- synced device roster (`nodes` table, system tier) ---------------------
//
// Who a device is (name, platform, app) is a workspace fact: every device must
// show the same answer for the same node id, and a purely bucket-joined device
// has no other channel to say its name. So the roster replicates through the
// oplog like any dataset. The device describes ITSELF on open (describeSelf);
// anyone may rename any device (setNodeLabel) — one identity per device, LWW.

export type NodePlatform = "macos" | "windows" | "linux" | "ios" | "android" | "web";
export type NodeForm = "laptop" | "desktop" | "phone" | "server" | "browser";
export type NodeApp = "cli" | "server" | "desktop" | "web";

export interface NodeMeta {
  node_id: string;
  label: string | null;
  platform: NodePlatform | null;
  form: NodeForm | null;
  app: NodeApp | null;
  first_seen: number | null;
}

const NODE_COLS = "id, label, platform, form, app, first_seen";
type NodeRow = {
  id: string;
  label: string | null;
  platform: string | null;
  form: string | null;
  app: string | null;
  first_seen: number | null;
};
const rowToMeta = (r: NodeRow): NodeMeta => ({
  node_id: r.id,
  label: r.label,
  platform: (r.platform as NodePlatform | null) ?? null,
  form: (r.form as NodeForm | null) ?? null,
  app: (r.app as NodeApp | null) ?? null,
  first_seen: r.first_seen,
});

/** The synced roster row for one node, or null when it never described itself
 *  (pre-roster devices, or a roster row not yet replicated here). Never throws
 *  on a missing table row — callers fall back through nodeLabelOf. */
export function readNodeMeta(db: DbDriver, nodeId: string): NodeMeta | null {
  const r = db
    .query(`SELECT ${NODE_COLS} FROM nodes WHERE id = ? AND __deleted = 0`)
    .get(nodeId) as NodeRow | null;
  return r ? rowToMeta(r) : null;
}

/** Every roster row this device has replicated. */
export function listNodeMeta(db: DbDriver): NodeMeta[] {
  return (
    db.query(`SELECT ${NODE_COLS} FROM nodes WHERE __deleted = 0`).all() as NodeRow[]
  ).map(rowToMeta);
}

/** Node-local legacy label (pre-roster `meta.node_label`). Read-only fallback;
 *  writes go to the synced roster and mirror here for downgrade safety. */
function legacySelfLabel(db: DbDriver): string | null {
  const row = db
    .query("SELECT value FROM meta WHERE key = 'node_label'")
    .get() as { value: string } | null;
  return row?.value ?? null;
}

function mirrorLegacySelfLabel(db: DbDriver, label: string | null): void {
  if (label == null) {
    db.query("DELETE FROM meta WHERE key = 'node_label'").run();
    return;
  }
  db.query(
    "INSERT INTO meta (key, value) VALUES ('node_label', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(label);
}

/** Display name for ANY node id, with the honest fallback chain:
 *  synced roster → the label we gave it when pairing (peers.label) →
 *  (self only) the legacy node-local label → null (the UI renders "unnamed").
 *  Never throws. */
export function nodeLabelOf(db: DbDriver, nodeId: string): string | null {
  const synced = readNodeMeta(db, nodeId)?.label;
  if (synced) return synced;
  const peer = db
    .query("SELECT label FROM peers WHERE node_id = ? AND label IS NOT NULL AND label <> '' LIMIT 1")
    .get(nodeId) as { label: string } | null;
  if (peer?.label) return peer.label;
  return nodeId === getNodeId(db) ? legacySelfLabel(db) : null;
}

/** Optional human label for THIS device. */
export function getNodeLabel(db: DbDriver): string | null {
  return nodeLabelOf(db, getNodeId(db));
}

/** Rename a device (default: this one). Empty/null clears. Writes the synced
 *  roster; a no-op when the label is already that value (nothing enters the
 *  oplog). Self renames also mirror into meta.node_label. */
export function setNodeLabel(db: DbDriver, label: string | null, nodeId?: string): void {
  const id = nodeId ?? getNodeId(db);
  const next = label == null || label.trim() === "" ? null : label.trim();
  const cur = readNodeMeta(db, id);
  if (id === getNodeId(db)) mirrorLegacySelfLabel(db, next);
  if (cur && cur.label === next) return;
  if (!cur && next == null) return;
  withChangeGroup("node", () => {
    emit(db, "nodes", id, "label", next);
  });
}

export interface SelfDescription {
  platform?: NodePlatform | null;
  form?: NodeForm | null;
  app?: NodeApp | null;
  /** Used only when the device has no name anywhere yet (e.g. the hostname). */
  defaultLabel?: string | null;
  /** Injected clock for tests. */
  now?: number;
}

/** Record what THIS device is in the synced roster. Idempotent: only columns
 *  whose value actually differs are emitted, so a routine open produces no
 *  oplog change. First run migrates the legacy node-local label, else adopts
 *  `defaultLabel`, and stamps first_seen. */
export function describeSelf(db: DbDriver, info: SelfDescription = {}): NodeMeta {
  const id = getNodeId(db);
  const cur = readNodeMeta(db, id);
  const fields: Record<string, unknown> = {};
  if (info.platform !== undefined && (cur?.platform ?? null) !== info.platform)
    fields.platform = info.platform;
  if (info.form !== undefined && (cur?.form ?? null) !== info.form) fields.form = info.form;
  if (info.app !== undefined && (cur?.app ?? null) !== info.app) fields.app = info.app;
  if (cur?.first_seen == null) fields.first_seen = info.now ?? Date.now();
  if (!cur?.label) {
    const seed = legacySelfLabel(db) ?? info.defaultLabel ?? null;
    if (seed) fields.label = seed;
  }
  if (Object.keys(fields).length > 0) {
    withChangeGroup("node", () => {
      for (const [col, v] of Object.entries(fields)) emit(db, "nodes", id, col, v);
    });
  }
  return readNodeMeta(db, id)!;
}

/** Map a Node/Bun `process.platform` string to the roster vocabulary. */
export function platformFromProcess(p: string): NodePlatform | null {
  switch (p) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    case "android":
      return "android";
    default:
      return null;
  }
}

/** Default form factor for a platform+app pair — a display heuristic (the icon),
 *  not a claim; the user renames, the app kind is what actually varies. */
export function defaultForm(platform: NodePlatform | null, app: NodeApp | null): NodeForm | null {
  if (app === "web") return "browser";
  if (platform === "ios" || platform === "android") return "phone";
  if (platform === "linux") return "server";
  if (platform === "macos" || platform === "windows") return "laptop";
  return null;
}

export interface NodeInfo {
  node_id: string;
  label: string | null;
  self: boolean;
  platform: NodePlatform | null;
  form: NodeForm | null;
  app: NodeApp | null;
}

/** Display roster: this device plus every node id known locally (paired peers,
 *  synced roster rows), each with the label fallback chain. Shared by GET
 *  /api/nodes and the replica's `nodes` op so the two can't drift. */
export function displayNodes(db: DbDriver): NodeInfo[] {
  const self = getNodeId(db);
  const ids = new Set<string>([self]);
  for (const r of listNodeMeta(db)) ids.add(r.node_id);
  const peers = db
    .query("SELECT node_id FROM peers WHERE node_id IS NOT NULL AND node_id <> '' GROUP BY node_id")
    .all() as { node_id: string }[];
  for (const p of peers) ids.add(p.node_id);
  const out = [...ids].map((node_id) => {
    const m = readNodeMeta(db, node_id);
    return {
      node_id,
      label: nodeLabelOf(db, node_id),
      self: node_id === self,
      platform: m?.platform ?? null,
      form: m?.form ?? null,
      app: m?.app ?? null,
    };
  });
  out.sort((a, b) => Number(b.self) - Number(a.self));
  return out;
}
