import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import { createDatabase } from "./databases.ts";
import { addProperty } from "./properties.ts";
import { getRecord, updateRecord } from "./records.ts";
import { parseHlc } from "./hlc.ts";
import { policyForShare } from "./access-policy.ts";
import { applyGuestIntent, type GuestIntent } from "./guest-intent.ts";
import type { AccessPolicy } from "./access-policy.ts";

function makeDb(node = "hostnode"): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(node);
  return db;
}

/** A share policy granting read+create+update on `dbId`. */
function policy(dbId: string): AccessPolicy {
  return policyForShare({
    grants: JSON.stringify({ v: 1, tables: [{ db: dbId, ops: ["read", "create", "update"] }] }),
    pw_salt: null,
    pw_hash: null,
    expires_at: null,
    guest_node_id: "gbase",
  });
}

function seed() {
  const db = makeDb();
  const d = createDatabase(db, { name: "Guestbook" });
  const title = addProperty(db, d.id, { name: "Title", type: "text" });
  return { db, dbId: d.id, titleId: title.id };
}

const INTENT = (over: Partial<GuestIntent>): GuestIntent => ({
  intentId: "int_" + Math.random().toString(36).slice(2),
  action: "createRecord",
  payload: {},
  submittedAt: Date.now(),
  ...over,
});

test("authority mode: create is attributed to the guest node, stamped at server clock", () => {
  const { db, dbId, titleId } = seed();
  const before = Date.now();
  const rec = applyGuestIntent(
    db,
    policy(dbId),
    { guestNode: "gbase-abc123" },
    INTENT({ action: "createRecord", table: dbId, payload: { Title: "hi" } }),
    { clock: "authority" },
  );
  expect(rec.cells[titleId]).toBe("hi");
  const rows = db
    .query("SELECT node_id, hlc FROM crdt_changes WHERE row_id = ? AND col = ?")
    .all(rec.id, titleId) as { node_id: string; hlc: string }[];
  expect(rows[0]!.node_id).toBe("gbase-abc123"); // guest-attributed
  expect(parseHlc(rows[0]!.hlc).millis).toBeGreaterThanOrEqual(before); // server clock ~now
});

test("submitted mode: op HLC carries the SUBMIT time, not the execution time", () => {
  const { db, dbId, titleId } = seed();
  const tuesday = Date.now() - 2 * 86_400_000; // 2 days ago
  const rec = applyGuestIntent(
    db,
    policy(dbId),
    { guestNode: "gbase-visitor1" },
    INTENT({ action: "createRecord", table: dbId, recordId: "rec_fixed01", payload: { Title: "from tuesday" }, submittedAt: tuesday }),
    { clock: "submitted" },
  );
  expect(rec.id).toBe("rec_fixed01"); // client-minted id is honored
  expect(rec.cells[titleId]).toBe("from tuesday");
  const row = db
    .query("SELECT hlc FROM crdt_changes WHERE row_id = ? AND col = ?")
    .get("rec_fixed01", titleId) as { hlc: string };
  // Executed now, but the HLC millis is the Tuesday submit time (not now).
  expect(parseHlc(row.hlc).millis).toBe(tuesday);
});

test("submitted mode: future submit time is clamped to now+5min", () => {
  const { db, dbId, titleId } = seed();
  const now = Date.now();
  const wayFuture = now + 60 * 86_400_000; // 60 days ahead
  applyGuestIntent(
    db,
    policy(dbId),
    { guestNode: "gbase-skew" },
    INTENT({ action: "createRecord", table: dbId, recordId: "rec_skew01", payload: { Title: "x" }, submittedAt: wayFuture }),
    { clock: "submitted", now },
  );
  const row = db
    .query("SELECT hlc FROM crdt_changes WHERE row_id = ? AND col = ?")
    .get("rec_skew01", titleId) as { hlc: string };
  expect(parseHlc(row.hlc).millis).toBe(now + 5 * 60_000); // clamped
});

test("submitted LWW: the later SUBMIT time wins regardless of execution order", () => {
  const { db, dbId, titleId } = seed();
  // A record exists.
  const rec = applyGuestIntent(
    db,
    policy(dbId),
    { guestNode: "gbase-a" },
    INTENT({ action: "createRecord", table: dbId, recordId: "rec_lww01", payload: { Title: "orig" }, submittedAt: Date.now() - 3 * 86_400_000 }),
    { clock: "submitted" },
  );
  const t1 = Date.now() - 2 * 86_400_000; // earlier submit
  const t2 = Date.now() - 1 * 86_400_000; // later submit
  // Apply the LATER-submitted update FIRST, then the earlier-submitted one.
  applyGuestIntent(db, policy(dbId), { guestNode: "gbase-b" },
    INTENT({ action: "updateRecord", recordId: rec.id, payload: { Title: "later-wins" }, submittedAt: t2 }),
    { clock: "submitted" });
  applyGuestIntent(db, policy(dbId), { guestNode: "gbase-c" },
    INTENT({ action: "updateRecord", recordId: rec.id, payload: { Title: "earlier-loses" }, submittedAt: t1 }),
    { clock: "submitted" });
  expect(getRecord(db, rec.id)!.cells[titleId]).toBe("later-wins"); // higher submit HLC won
});

test("submitted mode loses to a higher-clock owner edit (Tue submission can't beat Wed edit)", () => {
  const { db, dbId, titleId } = seed();
  const rec = applyGuestIntent(
    db,
    policy(dbId),
    { guestNode: "gbase-g" },
    INTENT({ action: "createRecord", table: dbId, recordId: "rec_o01", payload: { Title: "orig" }, submittedAt: Date.now() - 5 * 86_400_000 }),
    { clock: "submitted" });
  // Owner edits now (server clock, ~today = far after the guest's Tuesday).
  updateRecord(db, rec.id, { Title: "owner-now" });
  // A late-arriving guest update submitted 4 days ago is applied AFTER the owner edit.
  applyGuestIntent(db, policy(dbId), { guestNode: "gbase-late" },
    INTENT({ action: "updateRecord", recordId: rec.id, payload: { Title: "guest-tuesday" }, submittedAt: Date.now() - 4 * 86_400_000 }),
    { clock: "submitted" });
  expect(getRecord(db, rec.id)!.cells[titleId]).toBe("owner-now"); // owner's newer HLC wins
});

test("idempotency: replaying the same intentId returns the same row, no duplicate", () => {
  const { db, dbId } = seed();
  const intent = INTENT({ action: "createRecord", table: dbId, payload: { Title: "once" } });
  const a = applyGuestIntent(db, policy(dbId), { guestNode: "gbase-x" }, intent, { clock: "authority" });
  const b = applyGuestIntent(db, policy(dbId), { guestNode: "gbase-x" }, intent, { clock: "authority" });
  expect(b.id).toBe(a.id);
  const n = db.query("SELECT COUNT(*) AS n FROM records WHERE __deleted = 0").get() as { n: number };
  expect(n.n).toBe(1); // exactly one record despite two applies
});

test("submitted mode: two intents in the same millisecond both land (counter seeded past collision)", () => {
  const { db, dbId } = seed();
  const ms = Date.now() - 86_400_000;
  applyGuestIntent(db, policy(dbId), { guestNode: "gbase-same" },
    INTENT({ action: "createRecord", table: dbId, recordId: "rec_s1", payload: { Title: "one" }, submittedAt: ms }),
    { clock: "submitted" });
  applyGuestIntent(db, policy(dbId), { guestNode: "gbase-same" },
    INTENT({ action: "createRecord", table: dbId, recordId: "rec_s2", payload: { Title: "two" }, submittedAt: ms }),
    { clock: "submitted" });
  // Both records exist — no oplog UNIQUE collision silently dropped a write.
  expect(getRecord(db, "rec_s1")).not.toBeNull();
  expect(getRecord(db, "rec_s2")).not.toBeNull();
});

test("authority create honors grants (ungranted table → uniform auth error)", () => {
  const { db } = seed();
  const other = createDatabase(db, { name: "Secret" });
  let err: string | undefined;
  try {
    applyGuestIntent(db, policy("nonexistent"), { guestNode: "gbase-y" },
      INTENT({ action: "createRecord", table: other.id, payload: {} }), { clock: "authority" });
  } catch (e) {
    err = (e as { code?: string }).code;
  }
  expect(err).toBe("auth");
});
