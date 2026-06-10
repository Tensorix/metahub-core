import type { DbDriver } from "../driver.ts";
import { getNodeId } from "../node.ts";
import { ingest, changesAfterSeq } from "../crdt.ts";
import { type SyncResponse, SYNC_PATH } from "./protocol.ts";
import { MhError } from "../errors.ts";

interface PeerCursors {
  pull_cursor: number;
  push_cursor: number;
  token: string | null;
}

function getPeer(db: DbDriver, url: string): PeerCursors {
  const row = db
    .query("SELECT pull_cursor, push_cursor, token FROM peers WHERE url = ?")
    .get(url) as PeerCursors | null;
  return row ?? { pull_cursor: 0, push_cursor: 0, token: null };
}

function setPeer(db: DbDriver, url: string, c: { pull_cursor: number; push_cursor: number }): void {
  db.query(
    "INSERT INTO peers (url, pull_cursor, push_cursor) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET pull_cursor = excluded.pull_cursor, push_cursor = excluded.push_cursor",
  ).run(url, c.pull_cursor, c.push_cursor);
}

export interface SyncResult {
  pushed: number;
  pulled: number;
}

/**
 * Run one push/pull round against a peer server. A single round is bidirectional
 * (pushes local changes, pulls remote ones). `token` defaults to the credential
 * stored for this peer (set during pairing) and is sent as a Bearer header so a
 * token-gated /sync accepts the request.
 */
export async function syncWithPeer(
  db: DbDriver,
  url: string,
  token?: string,
): Promise<SyncResult> {
  const node = getNodeId(db);
  const peer = getPeer(db, url);
  const bearer = token ?? peer.token ?? undefined;
  const toPush = changesAfterSeq(db, peer.push_cursor);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(new URL(SYNC_PATH, url), {
    method: "POST",
    headers,
    body: JSON.stringify({ node_id: node, since: peer.pull_cursor, changes: toPush.changes }),
  });
  if (!res.ok)
    throw new MhError(
      res.status === 401 || res.status === 403 ? "auth" : "network",
      `sync failed: ${res.status} ${await res.text()}`,
    );

  const data = (await res.json()) as SyncResponse;
  const pulled = data.changes?.length ?? 0;
  ingest(db, data.changes ?? []);
  setPeer(db, url, { pull_cursor: data.cursor, push_cursor: toPush.cursor });

  return { pushed: toPush.changes.length, pulled };
}
