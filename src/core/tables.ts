// The table boundary — ONE declaration of every table in CORE_SCHEMA and which
// tier it belongs to. Everything that used to be a hand-written table list
// (snapshot's reset wipe, the schema tombstone test, the audit feed's
// exclusions) derives from here, and tables.test.ts pins PRAGMA table_list to
// exactly these keys: an unregistered table fails the build, so the boundary
// can't drift silently again.
//
//   content — things the user creates. Replicated, share-partitionable,
//             searchable, and visible in the audit feed.
//   system  — metahub's own workspace-level state (site channels, blob policy,
//             the device roster). Replicated so every node agrees, but never
//             part of a share partition and hidden from the audit feed by
//             default: it is infrastructure, not user activity.
//   local   — this machine only: cursors, credentials, caches, UI context.
//             Never enters the oplog.
//
// Pure data, no imports: crdt.ts / snapshot.ts / audit.ts all import this
// without a cycle.

export type Tier = "content" | "system" | "local";

export interface TableSpec {
  tier: Tier;
  /** Replicated through the CRDT oplog (has a DOMAIN entry in crdt.ts). */
  synced: boolean;
}

export const TABLES: Readonly<Record<string, TableSpec>> = {
  // content
  databases: { tier: "content", synced: true },
  properties: { tier: "content", synced: true },
  records: { tier: "content", synced: true },
  documents: { tier: "content", synced: true },
  doc_blocks: { tier: "content", synced: true },
  sites: { tier: "content", synced: true },
  site_files: { tier: "content", synced: true },
  // system
  site_channels: { tier: "system", synced: true },
  blob_policy: { tier: "system", synced: true },
  nodes: { tier: "system", synced: true },
  // local
  meta: { tier: "local", synced: false },
  crdt_changes: { tier: "local", synced: false },
  peers: { tier: "local", synced: false },
  storage_cursors: { tier: "local", synced: false },
  room_rows: { tier: "local", synced: false },
  peer_grants: { tier: "local", synced: false },
  pairing_codes: { tier: "local", synced: false },
  shares: { tier: "local", synced: false },
  site_channel_observations: { tier: "local", synced: false },
  blob_cache: { tier: "local", synced: false },
  drop_rejects: { tier: "local", synced: false },
  search_fts: { tier: "local", synced: false },
};

const names = (pred: (s: TableSpec) => boolean): readonly string[] =>
  Object.entries(TABLES)
    .filter(([, s]) => pred(s))
    .map(([n]) => n);

/** Tables replicated through the oplog (dataset name == table name). */
export const SYNCED_TABLES: readonly string[] = names((s) => s.synced);
export const CONTENT_TABLES: readonly string[] = names((s) => s.tier === "content");
/** Replicated infrastructure state — excluded from the audit feed and from
 *  share partitions. */
export const SYSTEM_DATASETS: readonly string[] = names((s) => s.tier === "system");
export const LOCAL_TABLES: readonly string[] = names((s) => s.tier === "local");

export const tierOf = (table: string): Tier | undefined => TABLES[table]?.tier;
