import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../schema-init.ts";
import { ingest, type Change } from "../crdt.ts";
import { syncWithPeer } from "./client.ts";
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
