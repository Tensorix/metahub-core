// Outbound peer management: the devices this node syncs *to*. Each row carries
// the durable credential the remote issued to us during pairing (see pairing.ts)
// plus replication cursors and last-sync status. `syncAllPeers` is what the
// server's auto-sync timer calls each tick.

import type { Database } from "bun:sqlite";
import { syncWithPeer, type SyncResult } from "./client.ts";

export interface PeerRow {
  url: string;
  pull_cursor: number;
  push_cursor: number;
  token: string | null;
  label: string | null;
  node_id: string | null;
  enabled: number;
  last_sync_at: number | null;
  last_status: string | null;
  last_error: string | null;
}

export function listPeers(db: Database): PeerRow[] {
  return db
    .query(
      "SELECT url, pull_cursor, push_cursor, token, label, node_id, enabled, last_sync_at, last_status, last_error FROM peers ORDER BY url",
    )
    .all() as PeerRow[];
}

export function getPeer(db: Database, url: string): PeerRow | null {
  return (db
    .query(
      "SELECT url, pull_cursor, push_cursor, token, label, node_id, enabled, last_sync_at, last_status, last_error FROM peers WHERE url = ?",
    )
    .get(url) as PeerRow | null) ?? null;
}

export interface AddPeerInput {
  url: string;
  token?: string | null;
  label?: string | null;
  node_id?: string | null;
}

/** Upsert a peer, preserving replication cursors on conflict. */
export function addPeer(db: Database, input: AddPeerInput): void {
  db.query(
    `INSERT INTO peers (url, token, label, node_id, enabled, pull_cursor, push_cursor)
     VALUES (?, ?, ?, ?, 1, 0, 0)
     ON CONFLICT(url) DO UPDATE SET
       token   = coalesce(excluded.token, peers.token),
       label   = coalesce(excluded.label, peers.label),
       node_id = coalesce(excluded.node_id, peers.node_id),
       enabled = 1`,
  ).run(input.url, input.token ?? null, input.label ?? null, input.node_id ?? null);
}

/**
 * Remove a peer AND revoke the credential we issued to it during pairing, so
 * disconnecting is mutual: we stop syncing out to it (peers row) and it can no
 * longer sync in to us (peer_grants row, keyed by peer_url). Grants minted for a
 * peer that never sent a self_url have a null peer_url and can't be revoked here.
 */
export function removePeer(db: Database, url: string): boolean {
  const tx = db.transaction(() => {
    const changed = db.query("DELETE FROM peers WHERE url = ?").run(url).changes > 0;
    db.query("DELETE FROM peer_grants WHERE peer_url = ?").run(url);
    return changed;
  });
  return tx();
}

export function setPeerEnabled(db: Database, url: string, enabled: boolean): boolean {
  return (
    db.query("UPDATE peers SET enabled = ? WHERE url = ?").run(enabled ? 1 : 0, url).changes > 0
  );
}

export function setPeerLabel(db: Database, url: string, label: string): boolean {
  return db.query("UPDATE peers SET label = ? WHERE url = ?").run(label, url).changes > 0;
}

export function updatePeerStatus(
  db: Database,
  url: string,
  status: string,
  error?: string | null,
): void {
  db.query(
    "UPDATE peers SET last_sync_at = ?, last_status = ?, last_error = ? WHERE url = ?",
  ).run(Date.now(), status, error ?? null, url);
}

export interface PeerSyncOutcome {
  url: string;
  ok: boolean;
  pushed?: number;
  pulled?: number;
  error?: string;
}

/** Sync once with a single peer, recording status. Errors are captured, not thrown. */
export async function syncPeer(db: Database, url: string): Promise<PeerSyncOutcome> {
  try {
    const result: SyncResult = await syncWithPeer(db, url);
    updatePeerStatus(db, url, "ok", null);
    return { url, ok: true, pushed: result.pushed, pulled: result.pulled };
  } catch (e) {
    const error = (e as Error).message;
    updatePeerStatus(db, url, "error", error);
    return { url, ok: false, error };
  }
}

/** Sync once with every enabled peer. Used by the auto-sync timer. */
export async function syncAllPeers(db: Database): Promise<PeerSyncOutcome[]> {
  const peers = listPeers(db).filter((p) => p.enabled);
  const out: PeerSyncOutcome[] = [];
  for (const p of peers) out.push(await syncPeer(db, p.url));
  return out;
}
