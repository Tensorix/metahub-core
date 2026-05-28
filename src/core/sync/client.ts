import type { Database } from "bun:sqlite";
import { getNodeId } from "../node.ts";
import { ingest, changesAfterSeq } from "../crdt.ts";
import { type SyncResponse, SYNC_PATH } from "./protocol.ts";

interface PeerCursors {
  pull_cursor: number;
  push_cursor: number;
}

function getPeer(db: Database, url: string): PeerCursors {
  const row = db
    .query("SELECT pull_cursor, push_cursor FROM peers WHERE url = ?")
    .get(url) as PeerCursors | null;
  return row ?? { pull_cursor: 0, push_cursor: 0 };
}

function setPeer(db: Database, url: string, c: PeerCursors): void {
  db.query(
    "INSERT INTO peers (url, pull_cursor, push_cursor) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET pull_cursor = excluded.pull_cursor, push_cursor = excluded.push_cursor",
  ).run(url, c.pull_cursor, c.push_cursor);
}

export interface SyncResult {
  pushed: number;
  pulled: number;
}

/** Run one push/pull round against a peer server. */
export async function syncWithPeer(db: Database, url: string): Promise<SyncResult> {
  const node = getNodeId(db);
  const peer = getPeer(db, url);
  const toPush = changesAfterSeq(db, peer.push_cursor);

  const res = await fetch(new URL(SYNC_PATH, url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ node_id: node, since: peer.pull_cursor, changes: toPush.changes }),
  });
  if (!res.ok) throw new Error(`sync failed: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as SyncResponse;
  const pulled = data.changes?.length ?? 0;
  ingest(db, data.changes ?? []);
  setPeer(db, url, { pull_cursor: data.cursor, push_cursor: toPush.cursor });

  return { pushed: toPush.changes.length, pulled };
}
