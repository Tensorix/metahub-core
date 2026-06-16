import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { addPeer, ensureFresh, updatePeerStatus } from "./peers.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  runSchema(db);
  return db;
}

test("updatePeerStatus records attempts but only successful syncs update freshness", () => {
  const db = makeDb();
  addPeer(db, { url: "http://peer" });

  updatePeerStatus(db, "http://peer", "error", "offline");
  let row = db.query("SELECT last_sync_at, last_success_at, last_status FROM peers WHERE url = ?").get(
    "http://peer",
  ) as { last_sync_at: number | null; last_success_at: number | null; last_status: string };
  expect(typeof row.last_sync_at).toBe("number");
  expect(row.last_success_at).toBeNull();
  expect(row.last_status).toBe("error");

  updatePeerStatus(db, "http://peer", "ok", null);
  row = db.query("SELECT last_sync_at, last_success_at, last_status FROM peers WHERE url = ?").get(
    "http://peer",
  ) as { last_sync_at: number | null; last_success_at: number | null; last_status: string };
  expect(typeof row.last_sync_at).toBe("number");
  expect(typeof row.last_success_at).toBe("number");
  expect(row.last_status).toBe("ok");
});

test("ensureFresh ignores a recent failed attempt when there is no recent success", async () => {
  const db = makeDb();
  addPeer(db, { url: "http://127.0.0.1:9" });
  updatePeerStatus(db, "http://127.0.0.1:9", "error", "offline");

  await ensureFresh(db, { maxAgeMs: 60_000 });

  const row = db.query("SELECT last_status, last_success_at FROM peers WHERE url = ?").get(
    "http://127.0.0.1:9",
  ) as { last_status: string | null; last_success_at: number | null };
  expect(row.last_status).toBe("error");
  expect(row.last_success_at).toBeNull();
});
