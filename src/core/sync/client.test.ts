import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../schema-init.ts";
import { changesAfterSeq, ingest, type Change } from "../crdt.ts";
import { createDatabase } from "../databases.ts";
import { advanceAckedPrefix, syncWithPeer } from "./client.ts";
import type { SyncResponse } from "./protocol.ts";

function makeDb(node: string): Database {
  const db = new Database(":memory:");
  initSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(node);
  return db;
}

function remoteChanges(n: number): Change[] {
  return Array.from({ length: n }, (_, i) => ({
    hlc: `000000000000000${i}-0000-remote`,
    node_id: "remote",
    dataset: "records",
    row_id: `r${i}`,
    col: "v",
    value: JSON.stringify(i),
    txn: null,
  }));
}

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function stubFetch(changes: Change[], cursor: number): void {
  globalThis.fetch = (async () => {
    const body: SyncResponse = { node_id: "remote", changes, cursor };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

test("syncWithPeer reports received = response page size, even when nothing is new", async () => {
  // Regression for the finite-sync pagination bug: a page of all-known changes
  // ingests 0 (`pulled`), but `received` must still equal the page size so the
  // hydration loop doesn't mistake a re-pulled page for "no more data".
  const db = makeDb("local");
  const changes = remoteChanges(5);
  ingest(db, changes); // we already hold all of them

  stubFetch(changes, 5);
  const r = await syncWithPeer(db, "http://peer", { pullLimit: 5 });

  expect(r.pulled).toBe(0); // nothing new to our oplog
  expect(r.received).toBe(5); // ...but the peer did return a full page
});

test("syncWithPeer counts genuinely new changes in both received and pulled", async () => {
  const db = makeDb("local");
  const changes = remoteChanges(3);

  stubFetch(changes, 3);
  const r = await syncWithPeer(db, "http://peer", { pullLimit: 3 });

  expect(r.pulled).toBe(3);
  expect(r.received).toBe(3);
});

test("a pull-only round leaves the peer fully acknowledged (no phantom BEHIND)", async () => {
  const db = makeDb("local");
  stubFetch(remoteChanges(3), 3);
  await syncWithPeer(db, "http://peer");

  const peer = db
    .query("SELECT push_cursor FROM peers WHERE url = ?")
    .get("http://peer") as { push_cursor: number };
  const max = (db.query("SELECT MAX(rowid) AS m FROM crdt_changes").get() as { m: number }).m;
  // The rows we just ingested came FROM the peer — the cursor must have
  // advanced past them, so status surfaces see zero lag right away.
  expect(peer.push_cursor).toBe(max);
  expect(changesAfterSeq(db, peer.push_cursor).changes).toHaveLength(0);
});

test("a real local edit after the sync still counts as unpushed", async () => {
  const db = makeDb("local");
  stubFetch(remoteChanges(2), 2);
  await syncWithPeer(db, "http://peer");
  createDatabase(db, { name: "Tasks" }); // genuine local write after the round

  const peer = db
    .query("SELECT push_cursor FROM peers WHERE url = ?")
    .get("http://peer") as { push_cursor: number };
  expect(changesAfterSeq(db, peer.push_cursor).changes.length).toBeGreaterThan(0);
});

test("advanceAckedPrefix stops at the first row NOT in the response", () => {
  const db = makeDb("local");
  const batch = remoteChanges(4);
  ingest(db, batch.slice(0, 2)); // seq 1-2: from the response
  createDatabase(db, { name: "X" }); // concurrent local write
  ingest(db, batch.slice(2)); // later response rows AFTER the local write

  // Only the contiguous prefix (seq 1-2) is acked; the local write and
  // everything after it stay unacknowledged even though later rows match.
  expect(advanceAckedPrefix(db, 0, batch)).toBe(2);
});

test("rows pulled from B still get pushed to C afterwards (cursor is per-peer)", async () => {
  const a = makeDb("nodeA");
  stubFetch(remoteChanges(3), 3);
  await syncWithPeer(a, "http://b");

  let pushedToC: Change[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    pushedToC = (JSON.parse(init!.body as string) as { changes: Change[] }).changes;
    const body: SyncResponse = { node_id: "nodeC", changes: [], cursor: 0 };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  await syncWithPeer(a, "http://c");

  expect(pushedToC.filter((c) => c.node_id === "remote")).toHaveLength(3);
});

test("bounded pushes drain every row before reporting no pending push", async () => {
  const db = makeDb("local");
  ingest(db, remoteChanges(8));
  const batches: Change[][] = [];
  const transport = (async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(init!.body as string);
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer grant");
    expect(request.limit).toBe(2);
    batches.push(request.changes);
    return Response.json({ node_id: "peer", changes: [], cursor: 0 });
  }) as typeof fetch;
  const pending: boolean[] = [];
  for (let round = 0; round < 3; round++) {
    const result = await syncWithPeer(db, "http://peer", {
      pushLimit: 3, pullLimit: 2, token: "grant", fetch: transport,
    });
    pending.push(result.pendingPush!);
  }
  expect(batches.map((b) => b.length)).toEqual([3, 3, 2]);
  expect(batches.flat().map((c) => c.row_id)).toEqual(remoteChanges(8).map((c) => c.row_id));
  expect(pending).toEqual([true, true, false]);
  db.close();
});

test("bounded push does not acknowledge deferred local rows while pulling", async () => {
  const db = makeDb("local");
  ingest(db, remoteChanges(5));
  const incoming = [{ ...remoteChanges(1)[0]!, row_id: "other", node_id: "another" }];
  stubFetch(incoming, 1);
  const result = await syncWithPeer(db, "http://peer", { pushLimit: 2 });
  const peer = db.query("SELECT push_cursor FROM peers").get() as { push_cursor: number };
  expect(peer.push_cursor).toBe(2);
  expect(result.pendingPush).toBe(true);
  expect(changesAfterSeq(db, peer.push_cursor).changes).toHaveLength(4);
  db.close();
});

test("lost response replays a bounded batch safely without advancing cursor early", async () => {
  const db = makeDb("local");
  const remote = makeDb("peer");
  ingest(db, remoteChanges(5));
  const delivered: number[] = [];
  let loseResponse = true;
  const transport = (async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(init!.body as string);
    delivered.push(ingest(remote, request.changes));
    if (loseResponse) {
      loseResponse = false;
      throw new Error("response lost");
    }
    return Response.json({ node_id: "peer", changes: [], cursor: 0 });
  }) as typeof fetch;
  await expect(syncWithPeer(db, "http://peer", { pushLimit: 3, fetch: transport })).rejects.toThrow("response lost");
  expect(db.query("SELECT * FROM peers").all()).toHaveLength(0);
  expect((await syncWithPeer(db, "http://peer", { pushLimit: 3, fetch: transport })).pendingPush).toBe(true);
  expect((await syncWithPeer(db, "http://peer", { pushLimit: 3, fetch: transport })).pendingPush).toBe(false);
  expect(delivered).toEqual([3, 0, 2]);
  expect(changesAfterSeq(remote, 0).changes).toHaveLength(5);
  db.close();
  remote.close();
});

test("timeout bounds response decoding and leaves cursors unchanged", async () => {
  const db = makeDb("local");
  const transport = (async () => ({ ok: true, json: () => new Promise(() => {}) })) as unknown as typeof fetch;
  await expect(syncWithPeer(db, "http://peer", { fetch: transport, timeoutMs: 10 })).rejects.toThrow("timed out");
  expect(db.query("SELECT * FROM peers").all()).toHaveLength(0);
  db.close();
});

test("session cancellation prevents a late response from mutating replica", async () => {
  const db = makeDb("local");
  const controller = new AbortController();
  let respond!: (response: Response) => void;
  const transport = (() => new Promise<Response>((resolve) => { respond = resolve; })) as typeof fetch;
  const round = syncWithPeer(db, "http://peer", { fetch: transport, signal: controller.signal });
  controller.abort(new Error("session disposed"));
  await expect(round).rejects.toThrow("session disposed");
  respond(Response.json({ node_id: "peer", changes: remoteChanges(2), cursor: 2 }));
  await Promise.resolve();
  expect(changesAfterSeq(db, 0).changes).toHaveLength(0);
  expect(db.query("SELECT * FROM peers").all()).toHaveLength(0);
  db.close();
});
