// Stage C1 convergence suite: two owner-device hubs + one room engine, all
// in-process bun:sqlite, transport = direct function call into the room-side
// handler (the same handler the Durable Object will host in C2).
//
// The invariant every test drives at: after quiescence, the room's whole
// winner set equals the partition projection of the converged hub —
// register by register — and the anti-entropy digests agree.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { createDatabase } from "../databases.ts";
import { addProperty } from "../properties.ts";
import { createRecord, updateRecord, deleteRecord } from "../records.ts";
import { createSite, putFileInline } from "../sites-core.ts";
import { emit, ingest, changesSince, type Change } from "../crdt.ts";
import { serializeGrantSet } from "../grants-core.ts";
import { errorCode } from "../errors.ts";
import {
  allWinners,
  applyPartitionDiff,
  computePartitionMembers,
  partitionChangesAfterSeq,
  partitionWinners,
  winnersDigest,
  type PartitionScope,
} from "./partition.ts";
import {
  handleGuestWrite,
  handleOwnerSync,
  initRoomDb,
  mintRoomGuestSub,
  readRoomConfig,
  setRoomState,
  ROOM_PROTOCOL_VERSION,
  type RoomConfig,
} from "./room-protocol.ts";
import {
  syncWithRoom,
  type RoomClientConfig,
  type RoomTransport,
} from "./room-client.ts";

const GUEST_BASE = "gtestbase";
const PEER_KEY = "room://t1";

function makeHub(node: string): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(node);
  return db;
}

/** Full bidirectional exchange between two hubs — stands in for the bucket /
 *  peer channel (idempotent, so re-exchanging everything is fine in tests). */
function exchange(a: Database, b: Database): void {
  ingest(b, changesSince(a, ""));
  ingest(a, changesSince(b, ""));
}

/** Move a record across databases — the one operation that changes partition
 *  membership (a raw register write, same shape the WebUI/CLI move emits). */
function moveRecord(db: Database, recordId: string, targetDbId: string): void {
  emit(db, "records", recordId, "database_id", targetDbId);
}

function regMap(rows: Change[]): Map<string, string> {
  return new Map(rows.map((c) => [`${c.dataset}|${c.row_id}|${c.col}`, `${c.hlc}|${c.value}`]));
}

interface Fx {
  A: Database;
  B: Database;
  room: Database;
  roomCfg: RoomConfig;
  X: string; // granted database id
  Y: string; // ungranted database id
  siteId: string;
  scope: PartitionScope;
  cfgA: RoomClientConfig;
  cfgB: RoomClientConfig;
  transport: RoomTransport;
}

function fixture(): Fx {
  const A = makeHub("nodeA");
  const X = createDatabase(A, { name: "tasks" }).id;
  addProperty(A, X, { name: "title", type: "text" });
  const Y = createDatabase(A, { name: "journal" }).id;
  addProperty(A, Y, { name: "title", type: "text" });
  const siteId = createSite(A, { name: "board" }).id;
  putFileInline(A, siteId, "index.html", { data: "<h1>board</h1>" });

  const B = makeHub("nodeB");
  exchange(A, B);

  const room = new Database(":memory:");
  const roomCfg = initRoomDb(room, {
    slug: "t1",
    guestBase: GUEST_BASE,
    grants: serializeGrantSet({
      v: 1,
      tables: [{ db: X, ops: ["read", "create", "update"] }],
    }),
  });

  const scope: PartitionScope = { grantedDbIds: [X], siteId };
  const transport: RoomTransport = async (req) => handleOwnerSync(room, req);
  return {
    A,
    B,
    room,
    roomCfg,
    X,
    Y,
    siteId,
    scope,
    cfgA: { peerKey: PEER_KEY, scope, guestBase: GUEST_BASE },
    cfgB: { peerKey: PEER_KEY, scope, guestBase: GUEST_BASE },
    transport,
  };
}

async function settle(
  db: Database,
  cfg: RoomClientConfig,
  transport: RoomTransport,
  opts: { limit?: number; digest?: boolean } = {},
) {
  let r = await syncWithRoom(db, cfg, transport, opts);
  while (r.pending) r = await syncWithRoom(db, cfg, transport, opts);
  return r;
}

function expectRoomMatches(fx: Fx, hub: Database): void {
  expect(regMap(allWinners(fx.room))).toEqual(regMap(partitionWinners(hub, fx.scope)));
  expect(winnersDigest(allWinners(fx.room))).toBe(winnersDigest(partitionWinners(hub, fx.scope)));
}

function roomOplogCount(fx: Fx, rowId?: string): number {
  const q = rowId
    ? fx.room.query("SELECT COUNT(*) AS n FROM crdt_changes WHERE row_id = ?").get(rowId)
    : fx.room.query("SELECT COUNT(*) AS n FROM crdt_changes").get();
  return (q as { n: number }).n;
}

function readCursors(db: Database): { pull: number; push: number } {
  const row = db
    .query("SELECT pull_cursor, push_cursor FROM peers WHERE url = ?")
    .get(PEER_KEY) as { pull_cursor: number; push_cursor: number } | null;
  return { pull: row?.pull_cursor ?? 0, push: row?.push_cursor ?? 0 };
}

// ---- partition primitives ---------------------------------------------------------

test("computePartitionMembers covers the five segments and keeps tombstones", () => {
  const fx = fixture();
  const rec = createRecord(fx.A, fx.X, { title: "kept" });
  createRecord(fx.A, fx.Y, { title: "outside" });
  deleteRecord(fx.A, rec.id); // tombstone: still a member (delete ≠ leave)

  const members = computePartitionMembers(fx.A, fx.scope);
  const key = (d: string, r: string) => members.some((m) => m.dataset === d && m.row_id === r);
  expect(key("databases", fx.X)).toBe(true);
  expect(key("records", rec.id)).toBe(true);
  expect(key("sites", fx.siteId)).toBe(true);
  expect(members.some((m) => m.dataset === "site_files")).toBe(true);
  expect(members.some((m) => m.dataset === "properties")).toBe(true);
  // nothing from the ungranted database, nothing from excluded datasets
  expect(key("databases", fx.Y)).toBe(false);
  const yRecords = members.filter(
    (m) =>
      m.dataset === "records" &&
      (fx.A.query("SELECT database_id AS d FROM records WHERE id = ?").get(m.row_id) as { d: string }).d === fx.Y,
  );
  expect(yRecords.length).toBe(0);
});

test("partitionChangesAfterSeq mirrors changesAfterSeq cursor semantics", () => {
  const fx = fixture();
  createRecord(fx.A, fx.X, { title: "a" });
  createRecord(fx.A, fx.X, { title: "b" });
  applyPartitionDiff(fx.A, PEER_KEY, {
    entered: computePartitionMembers(fx.A, fx.scope),
    left: [],
  });

  // limited scan: cursor stops at the last returned row
  const page1 = partitionChangesAfterSeq(fx.A, 0, PEER_KEY, { limit: 3 });
  expect(page1.changes.length).toBe(3);
  const page2 = partitionChangesAfterSeq(fx.A, page1.cursor, PEER_KEY, { limit: 3 });
  expect(page2.changes.length).toBe(3);
  expect(page2.changes[0]!.hlc).not.toBe(page1.changes[0]!.hlc);

  // exhaustion: cursor jumps to the table high-water even past excluded tails
  emit(fx.A, "documents", "doc-secret", "title", "not for the room");
  const rest = partitionChangesAfterSeq(fx.A, page2.cursor, PEER_KEY, {});
  const top = fx.A.query("SELECT MAX(seq) AS m FROM crdt_changes").get() as { m: number };
  expect(rest.cursor).toBe(top.m);
  expect(rest.changes.every((c) => c.dataset !== "documents")).toBe(true);
});

// ---- seed & steady state ------------------------------------------------------------

test("first seed pages baselines across rounds and converges", async () => {
  const fx = fixture();
  for (let i = 0; i < 25; i++) createRecord(fx.A, fx.X, { title: `task ${i}` });
  createRecord(fx.A, fx.Y, { title: "must not leak" });

  const first = await syncWithRoom(fx.A, fx.cfgA, fx.transport, { limit: 20 });
  expect(first.pending).toBe(true); // 25 records + db + props + site > one page

  await settle(fx.A, fx.cfgA, fx.transport, { limit: 20 });
  expectRoomMatches(fx, fx.A);

  const recs = fx.room
    .query("SELECT COUNT(*) AS n FROM records WHERE database_id = ?")
    .get(fx.X) as { n: number };
  expect(recs.n).toBe(25);
  // the ungranted database and its record never reached the room
  const dbs = fx.room.query("SELECT COUNT(*) AS n FROM databases").get() as { n: number };
  expect(dbs.n).toBe(1);
  // excluded datasets are absent from the room oplog entirely
  const docs = fx.room
    .query("SELECT COUNT(*) AS n FROM crdt_changes WHERE dataset IN ('documents','doc_blocks')")
    .get() as { n: number };
  expect(docs.n).toBe(0);
  // the site shell arrived
  const files = fx.room
    .query("SELECT COUNT(*) AS n FROM site_files WHERE site_id = ?")
    .get(fx.siteId) as { n: number };
  expect(files.n).toBe(1);
});

test("steady-state increments flow without re-baselining", async () => {
  const fx = fixture();
  const rec = createRecord(fx.A, fx.X, { title: "v1" });
  await settle(fx.A, fx.cfgA, fx.transport);
  const before = roomOplogCount(fx);

  updateRecord(fx.A, rec.id, { title: "v2" });
  const r = await settle(fx.A, fx.cfgA, fx.transport);
  expect(r.pushed).toBe(1); // exactly the one edited register, no baseline resend
  expect(roomOplogCount(fx)).toBe(before + 1);
  expectRoomMatches(fx, fx.A);
});

// ---- membership boundary table (design.md §6) ---------------------------------------

test("moved in then out between rounds leaves no trace in the room", async () => {
  const fx = fixture();
  const rec = createRecord(fx.A, fx.Y, { title: "ghost" });
  await settle(fx.A, fx.cfgA, fx.transport);

  moveRecord(fx.A, rec.id, fx.X); // in…
  moveRecord(fx.A, rec.id, fx.Y); // …and out, all inside one between-rounds window
  const r = await settle(fx.A, fx.cfgA, fx.transport);

  expect(r.evicted).toBe(0);
  expect(roomOplogCount(fx, rec.id)).toBe(0);
  expect(fx.room.query("SELECT 1 FROM records WHERE id = ?").get(rec.id)).toBeNull();
  expectRoomMatches(fx, fx.A);
});

test("moved out then back in stays a continuous member (no evict round-trip)", async () => {
  const fx = fixture();
  const rec = createRecord(fx.A, fx.X, { title: "keeper" });
  await settle(fx.A, fx.cfgA, fx.transport);

  moveRecord(fx.A, rec.id, fx.Y);
  moveRecord(fx.A, rec.id, fx.X);
  const r = await settle(fx.A, fx.cfgA, fx.transport);

  expect(r.evicted).toBe(0);
  // both hops rode the ordinary increment — history intact, winner is "back in X"
  const moves = fx.room
    .query("SELECT COUNT(*) AS n FROM crdt_changes WHERE row_id = ? AND col = 'database_id'")
    .get(rec.id) as { n: number };
  expect(moves.n).toBe(3); // create + out + back
  expectRoomMatches(fx, fx.A);
});

test("an offline window nets out to one diff", async () => {
  const fx = fixture();
  const a = createRecord(fx.A, fx.X, { title: "a" });
  const b = createRecord(fx.A, fx.Y, { title: "b" });
  await settle(fx.A, fx.cfgA, fx.transport);

  // long offline window: many mutations, zero rounds
  for (let i = 0; i < 5; i++) updateRecord(fx.A, a.id, { title: `a${i}` });
  moveRecord(fx.A, a.id, fx.Y); // leaves
  moveRecord(fx.A, b.id, fx.X); // enters
  const c = createRecord(fx.A, fx.X, { title: "c" });
  updateRecord(fx.A, c.id, { title: "c2" });
  deleteRecord(fx.A, c.id);

  const r = await settle(fx.A, fx.cfgA, fx.transport);
  expect(r.evicted).toBe(1);
  expect(fx.room.query("SELECT 1 FROM records WHERE id = ?").get(a.id)).toBeNull();
  expect(roomOplogCount(fx, a.id)).toBe(0); // evict = physical deletion, no residue
  const cRow = fx.room
    .query("SELECT __deleted AS d FROM records WHERE id = ?")
    .get(c.id) as { d: number };
  expect(cRow.d).toBe(1); // tombstone flowed normally — delete is not eviction
  expectRoomMatches(fx, fx.A);
});

test("a deleted record stays in the room as a tombstone", async () => {
  const fx = fixture();
  const rec = createRecord(fx.A, fx.X, { title: "to delete" });
  await settle(fx.A, fx.cfgA, fx.transport);
  deleteRecord(fx.A, rec.id);
  await settle(fx.A, fx.cfgA, fx.transport);
  const row = fx.room
    .query("SELECT __deleted AS d FROM records WHERE id = ?")
    .get(rec.id) as { d: number };
  expect(row.d).toBe(1);
  expectRoomMatches(fx, fx.A);
});

// ---- dedup / retry ------------------------------------------------------------------

test("re-sent baselines dedup on the room oplog UNIQUE", async () => {
  const fx = fixture();
  const rec = createRecord(fx.A, fx.X, { title: "stable" });
  await settle(fx.A, fx.cfgA, fx.transport);
  const before = roomOplogCount(fx);

  // Simulate a lost shadow (device restore, split): the row re-enters and its
  // baseline is re-sent — the room must not grow a single duplicate row.
  fx.A.query("DELETE FROM room_rows WHERE peer_key = ? AND row_id = ?").run(PEER_KEY, rec.id);
  await settle(fx.A, fx.cfgA, fx.transport);
  expect(roomOplogCount(fx)).toBe(before);
  expectRoomMatches(fx, fx.A);
});

test("a lost response retries idempotently (cursors never advance early)", async () => {
  const fx = fixture();
  const rec = createRecord(fx.A, fx.X, { title: "v1" });
  await settle(fx.A, fx.cfgA, fx.transport);

  const sub = mintRoomGuestSub(fx.roomCfg);
  handleGuestWrite(fx.room, fx.roomCfg, { sub }, {
    op: "updateRecord",
    record: rec.id,
    values: { title: "guest edit" },
  });
  updateRecord(fx.A, rec.id, { title: "owner edit" });

  // Round 1: the room processes the request but the response is lost.
  let lose = true;
  const flaky: RoomTransport = async (req) => {
    const resp = handleOwnerSync(fx.room, req);
    if (lose) {
      lose = false;
      throw new Error("simulated lost response");
    }
    return resp;
  };
  const cursorsBefore = readCursors(fx.A);
  await expect(syncWithRoom(fx.A, fx.cfgA, flaky)).rejects.toThrow("lost response");
  expect(readCursors(fx.A)).toEqual(cursorsBefore); // nothing committed

  const roomBefore = roomOplogCount(fx);
  const r = await settle(fx.A, fx.cfgA, flaky); // retry: byte-identical resend
  expect(roomOplogCount(fx)).toBe(roomBefore); // room-side dedup, no growth
  expect(r.pulled).toBeGreaterThan(0); // the guest op was re-delivered
  const guestOps = fx.A
    .query("SELECT COUNT(*) AS n FROM crdt_changes WHERE node_id LIKE ? || '-%'")
    .get(GUEST_BASE) as { n: number };
  expect(guestOps.n).toBe(1); // ingested exactly once
  expectRoomMatches(fx, fx.A);
});

// ---- guest writes -------------------------------------------------------------------

test("guest write flows back to both devices with per-visitor attribution", async () => {
  const fx = fixture();
  await settle(fx.A, fx.cfgA, fx.transport);

  const sub = mintRoomGuestSub(fx.roomCfg);
  expect(sub.startsWith(GUEST_BASE + "-")).toBe(true);
  const created = handleGuestWrite(fx.room, fx.roomCfg, { sub }, {
    op: "createRecord",
    db: fx.X,
    values: { title: "from guest" },
  });

  const sent: Change[][] = [];
  const spying: RoomTransport = async (req) => {
    sent.push(req.changes);
    return handleOwnerSync(fx.room, req);
  };
  const r = await settle(fx.A, fx.cfgA, spying);
  expect(r.pulled).toBeGreaterThan(0);

  // every op of the new record is authored by the visitor's sub id
  const authors = fx.A
    .query("SELECT DISTINCT node_id AS n FROM crdt_changes WHERE row_id = ?")
    .all(created.id) as { n: string }[];
  expect(authors.map((a) => a.n)).toEqual([sub]);

  // …and it spreads to device B through the ordinary hub channel
  exchange(fx.A, fx.B);
  const onB = fx.B
    .query("SELECT database_id AS d, data FROM records WHERE id = ?")
    .get(created.id) as { d: string; data: string };
  expect(onB.d).toBe(fx.X);
  expect(onB.data).toContain("from guest");

  // echo suppression: no later push ever re-sends guest-authored ops
  sent.length = 0;
  updateRecord(fx.A, created.id, { title: "owner touch" });
  await settle(fx.A, fx.cfgA, spying);
  for (const batch of sent)
    for (const c of batch) expect(c.node_id.startsWith(GUEST_BASE)).toBe(false);
  expectRoomMatches(fx, fx.A);
});

test("guest writes obey the grants snapshot and session shape", async () => {
  const fx = fixture();
  await settle(fx.A, fx.cfgA, fx.transport);
  const sub = mintRoomGuestSub(fx.roomCfg);

  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return errorCode(e);
    }
    return undefined;
  };

  // ungranted database: denied, indistinguishable from nonexistent
  expect(
    code(() =>
      handleGuestWrite(fx.room, fx.roomCfg, { sub }, { op: "createRecord", db: fx.Y, values: { title: "x" } }),
    ),
  ).toBe("auth");
  // a sub id outside the share's guest base: denied
  expect(
    code(() =>
      handleGuestWrite(fx.room, fx.roomCfg, { sub: "evil-1" }, { op: "createRecord", db: fx.X, values: { title: "x" } }),
    ),
  ).toBe("auth");
  // expired room: everything is denied
  setRoomState(fx.room, "expired");
  const expiredCfg = readRoomConfig(fx.room);
  expect(
    code(() =>
      handleGuestWrite(fx.room, expiredCfg, { sub }, { op: "createRecord", db: fx.X, values: { title: "x" } }),
    ),
  ).toBe("auth");
});

test("evict racing an unpulled guest op defers its GC until acked", async () => {
  const fx = fixture();
  const rec = createRecord(fx.A, fx.X, { title: "contended" });
  await settle(fx.A, fx.cfgA, fx.transport);

  const sub = mintRoomGuestSub(fx.roomCfg);
  handleGuestWrite(fx.room, fx.roomCfg, { sub }, {
    op: "updateRecord",
    record: rec.id,
    values: { title: "guest last words" },
  });
  // owner moves the row out BEFORE pulling the guest op
  moveRecord(fx.A, rec.id, fx.Y);

  const r = await settle(fx.A, fx.cfgA, fx.transport);
  expect(r.evicted).toBe(1);
  expect(r.pulled).toBeGreaterThan(0); // the evict did NOT swallow the guest op
  // owner holds the guest edit (on a row that now lives in the private db)
  const got = fx.A
    .query("SELECT COUNT(*) AS n FROM crdt_changes WHERE row_id = ? AND node_id = ?")
    .get(rec.id, sub) as { n: number };
  expect(got.n).toBe(1);

  // room: state row gone, guest op parked pending ack
  expect(fx.room.query("SELECT 1 FROM records WHERE id = ?").get(rec.id)).toBeNull();
  expect(fx.room.query("SELECT 1 FROM evict_pending WHERE row_id = ?").get(rec.id)).not.toBeNull();
  expect(roomOplogCount(fx, rec.id)).toBe(1);

  // next round's since covers the pull → deferred GC completes, zero residue
  await settle(fx.A, fx.cfgA, fx.transport);
  expect(roomOplogCount(fx, rec.id)).toBe(0);
  expect(fx.room.query("SELECT 1 FROM evict_pending WHERE row_id = ?").get(rec.id)).toBeNull();
  expectRoomMatches(fx, fx.A);
});

// ---- shadow splits & self-healing ----------------------------------------------------

function moveOp(node: string, recId: string, dbId: string, hlcTail: string): Change {
  return {
    hlc: `99999999999999${hlcTail}-0000-${node}`,
    node_id: node,
    dataset: "records",
    row_id: recId,
    col: "database_id",
    value: JSON.stringify(dbId),
    txn: null,
  };
}

/** Set up the canonical split: rec is in the room via both devices; B (having
 *  seen only its own move-out) evicts it; the hubs then converge to "rec is IN
 *  the partition" (A's re-assert wins). A's shadow claims the room holds the
 *  row, so A's later rounds only push what is new to A — B's LOSING move op —
 *  which re-materializes a zombie register in the room. Room state ≠ partition
 *  projection, and no plain diff can see it. */
async function makeShadowSplit(fx: Fx): Promise<{ recId: string }> {
  const rec = createRecord(fx.A, fx.X, { title: "contested" });
  exchange(fx.A, fx.B);
  await settle(fx.A, fx.cfgA, fx.transport);
  await settle(fx.B, fx.cfgB, fx.transport);

  // concurrent: B moves it OUT (earlier HLC), A re-asserts it IN (later HLC)
  ingest(fx.B, [moveOp("nodeB", rec.id, fx.Y, "0")]);
  ingest(fx.A, [moveOp("nodeA", rec.id, fx.X, "1")]);

  await settle(fx.A, fx.cfgA, fx.transport); // A: still member, pushes its re-assert
  await settle(fx.B, fx.cfgB, fx.transport); // B: left → evict (physically deletes the row, A's ops included)
  expect(fx.room.query("SELECT 1 FROM records WHERE id = ?").get(rec.id)).toBeNull();

  exchange(fx.A, fx.B); // hubs converge: A's re-assert wins → rec ∈ X
  await settle(fx.A, fx.cfgA, fx.transport); // A pushes B's losing op (its only news) → zombie
  expect(regMap(allWinners(fx.room))).not.toEqual(regMap(partitionWinners(fx.A, fx.scope)));
  return { recId: rec.id };
}

test("concurrent moves, final state OUT of the partition: plain diff converges", async () => {
  const fx = fixture();
  const rec = createRecord(fx.A, fx.X, { title: "contested" });
  exchange(fx.A, fx.B);
  await settle(fx.A, fx.cfgA, fx.transport);
  await settle(fx.B, fx.cfgB, fx.transport);

  // A re-asserts IN (earlier), B moves OUT (later — B wins)
  ingest(fx.A, [moveOp("nodeA", rec.id, fx.X, "0")]);
  ingest(fx.B, [moveOp("nodeB", rec.id, fx.Y, "1")]);
  await settle(fx.A, fx.cfgA, fx.transport);
  await settle(fx.B, fx.cfgB, fx.transport); // B's evict lands
  exchange(fx.A, fx.B); // converge: rec ∈ Y
  const r = await settle(fx.A, fx.cfgA, fx.transport); // A now sees "left" → evict (idempotent)
  expect(r.evicted).toBe(1);
  expect(roomOplogCount(fx, rec.id)).toBe(0);
  expectRoomMatches(fx, fx.A);
  expect(regMap(partitionWinners(fx.A, fx.scope))).toEqual(regMap(partitionWinners(fx.B, fx.scope)));
});

test("shadow split heals via need_baseline when the row is touched again", async () => {
  const fx = fixture();
  const rec = createRecord(fx.A, fx.X, { title: "contested" });
  exchange(fx.A, fx.B);
  await settle(fx.A, fx.cfgA, fx.transport);
  await settle(fx.B, fx.cfgB, fx.transport);

  // B moves the row out and evicts it; A has not seen the move yet.
  ingest(fx.B, [moveOp("nodeB", rec.id, fx.Y, "0")]);
  await settle(fx.B, fx.cfgB, fx.transport);
  expect(fx.room.query("SELECT 1 FROM records WHERE id = ?").get(rec.id)).toBeNull();

  // A edits a CELL: the increment carries only the cell op, which materializes
  // an orphan row-side (no database_id register) → the room reports
  // need_baseline → the same sync call answers with the full row baseline,
  // re-judged against A's CURRENT membership (still in X, as far as A knows).
  updateRecord(fx.A, rec.id, { title: "edited after split" });
  await settle(fx.A, fx.cfgA, fx.transport);
  const row = fx.room
    .query("SELECT database_id AS d FROM records WHERE id = ?")
    .get(rec.id) as { d: string | null } | null;
  expect(row?.d).toBe(fx.X);
  expectRoomMatches(fx, fx.A);

  // Later the hubs converge (B's future-stamped move wins) and A evicts.
  exchange(fx.A, fx.B);
  const r = await settle(fx.A, fx.cfgA, fx.transport);
  expect(r.evicted).toBe(1);
  expect(roomOplogCount(fx, rec.id)).toBe(0);
  expectRoomMatches(fx, fx.A);
});

test("shadow split heals via digest anti-entropy when nothing else moves", async () => {
  const fx = fixture();
  await makeShadowSplit(fx);

  // No further edits, splitting device offline forever: only the digest can
  // notice. A digest round detects the mismatch and full-reconciles.
  const r = await syncWithRoom(fx.A, fx.cfgA, fx.transport, { digest: true });
  expect(r.healed).toBe(true);
  expectRoomMatches(fx, fx.A);

  // a clean digest round stays clean
  const r2 = await syncWithRoom(fx.A, fx.cfgA, fx.transport, { digest: true });
  expect(r2.healed).toBe(false);
});

test("shadow split heals via the splitting device's own next round", async () => {
  const fx = fixture();
  const { recId } = await makeShadowSplit(fx);

  // B (which evicted) now holds the converged "rec ∈ X" and re-enters it.
  const r = await settle(fx.B, fx.cfgB, fx.transport);
  expect(r.pushed).toBeGreaterThan(0);
  expect(fx.room.query("SELECT 1 FROM records WHERE id = ?").get(recId)).not.toBeNull();
  expectRoomMatches(fx, fx.B);
});

// ---- lifecycle ----------------------------------------------------------------------

test("a revoked share answers share_state expired and commits nothing", async () => {
  const fx = fixture();
  createRecord(fx.A, fx.X, { title: "x" });
  await settle(fx.A, fx.cfgA, fx.transport);
  const cursors = readCursors(fx.A);

  setRoomState(fx.room, "expired");
  updateRecord(fx.A, fx.A.query("SELECT id FROM records LIMIT 1").get()!["id" as never], { title: "y" });
  const r = await syncWithRoom(fx.A, fx.cfgA, fx.transport);
  expect(r.shareState).toBe("expired");
  expect(readCursors(fx.A)).toEqual(cursors);
});

test("protocol major mismatch is refused loudly", () => {
  const fx = fixture();
  expect(() =>
    handleOwnerSync(fx.room, {
      protocol: ROOM_PROTOCOL_VERSION + 1,
      node_id: "nodeA",
      since: 0,
      changes: [],
      evict: [],
    }),
  ).toThrow("upgrade required");
});

test("the owner refuses non-guest-authored ops from a room", async () => {
  const fx = fixture();
  await settle(fx.A, fx.cfgA, fx.transport);
  const evil: RoomTransport = async (req) => {
    const resp = handleOwnerSync(fx.room, req);
    return {
      ...resp,
      changes: [
        {
          hlc: "999999999999999-0000-nodeB",
          node_id: "nodeB", // impersonating an owner device
          dataset: "records",
          row_id: "rec-fake",
          col: "database_id",
          value: JSON.stringify(fx.X),
          txn: null,
        },
      ],
    };
  };
  await expect(syncWithRoom(fx.A, fx.cfgA, evil)).rejects.toThrow("refusing to ingest");
  expect(fx.A.query("SELECT 1 FROM crdt_changes WHERE row_id = 'rec-fake'").get()).toBeNull();
});

// ---- randomized convergence -----------------------------------------------------------

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("randomized interleaving converges to the partition projection", async () => {
  const fx = fixture();
  const rand = mulberry32(0xc0ffee);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

  await settle(fx.A, fx.cfgA, fx.transport); // room knows the granted db

  // transport that sometimes loses the response after the room applied it
  const flaky: RoomTransport = async (req) => {
    const resp = handleOwnerSync(fx.room, req);
    if (rand() < 0.15) throw new Error("flaky loss");
    return resp;
  };

  const pool: string[] = [];
  const subs = [mintRoomGuestSub(fx.roomCfg), mintRoomGuestSub(fx.roomCfg)];
  let n = 0;
  const devices = [
    { db: fx.A, cfg: fx.cfgA },
    { db: fx.B, cfg: fx.cfgB },
  ];

  for (let i = 0; i < 250; i++) {
    const dev = pick(devices);
    const dice = rand();
    try {
      if (dice < 0.25) {
        // create on a device, in the granted or the private db
        const rec = createRecord(dev.db, rand() < 0.7 ? fx.X : fx.Y, { title: `r${n++}-${i}` });
        pool.push(rec.id);
      } else if (dice < 0.45 && pool.length) {
        updateRecord(dev.db, pick(pool), { title: `v${n++}` });
      } else if (dice < 0.6 && pool.length) {
        moveRecord(dev.db, pick(pool), rand() < 0.5 ? fx.X : fx.Y);
      } else if (dice < 0.7) {
        // guest activity in the room
        if (rand() < 0.5 || pool.length === 0) {
          const rec = handleGuestWrite(fx.room, fx.roomCfg, { sub: pick(subs) }, {
            op: "createRecord",
            db: fx.X,
            values: { title: `g${n++}` },
          });
          pool.push(rec.id);
        } else {
          handleGuestWrite(fx.room, fx.roomCfg, { sub: pick(subs) }, {
            op: "updateRecord",
            record: pick(pool),
            values: { title: `gu${n++}` },
          });
        }
      } else if (dice < 0.9) {
        // a sync round for one device — may lose its response (offline windows
        // emerge naturally from stretches without rounds)
        await syncWithRoom(dev.db, dev.cfg, flaky, { limit: 40 });
      } else {
        exchange(fx.A, fx.B);
      }
    } catch (e) {
      // expected mid-run noise: flaky transport, guest ops against rows that
      // moved/vanished, edits to rows a device hasn't materialized yet
      const msg = (e as Error).message;
      if (!/flaky loss|unauthorized|no such record/.test(msg)) throw e;
    }
  }

  // quiesce: converge the hubs, drain both devices' rounds, ack guest pulls
  for (let k = 0; k < 4; k++) {
    exchange(fx.A, fx.B);
    await settle(fx.A, fx.cfgA, fx.transport, { limit: 40 });
    await settle(fx.B, fx.cfgB, fx.transport, { limit: 40 });
  }
  // anti-entropy passes until clean on both devices
  for (const dev of devices) {
    let r = await syncWithRoom(dev.db, dev.cfg, fx.transport, { digest: true });
    if (r.healed) r = await syncWithRoom(dev.db, dev.cfg, fx.transport, { digest: true });
    expect(r.healed).toBe(false);
    exchange(fx.A, fx.B);
  }
  await settle(fx.A, fx.cfgA, fx.transport);
  await settle(fx.B, fx.cfgB, fx.transport);

  // the invariant: room winners == partition projection, register for register
  const projA = regMap(partitionWinners(fx.A, fx.scope));
  const projB = regMap(partitionWinners(fx.B, fx.scope));
  expect(projA).toEqual(projB);
  expect(regMap(allWinners(fx.room))).toEqual(projA);
  expect(winnersDigest(allWinners(fx.room))).toBe(winnersDigest(partitionWinners(fx.A, fx.scope)));
}, 30_000);

// ---- guest pull paging (C2) -----------------------------------------------------------

test("a big guest-op backlog pages across rounds (more → pending) and converges", async () => {
  const fx = fixture();
  await settle(fx.A, fx.cfgA, fx.transport);

  // 260 guest creates ≈ 1300 oplog rows — beyond one GUEST_PULL_LIMIT page.
  const sub = mintRoomGuestSub(fx.roomCfg);
  for (let i = 0; i < 260; i++) {
    handleGuestWrite(fx.room, fx.roomCfg, { sub }, {
      op: "createRecord",
      db: fx.X,
      values: { title: `guest ${i}` },
    });
  }

  const r1 = await syncWithRoom(fx.A, fx.cfgA, fx.transport);
  expect(r1.pulled).toBeGreaterThan(0);
  expect(r1.pending).toBe(true); // room-side truncation rides back as pending
  await settle(fx.A, fx.cfgA, fx.transport);

  // every guest record arrived exactly once, and the ends agree
  const titles = fx.A
    .query("SELECT COUNT(*) AS n FROM records WHERE database_id = ?")
    .get(fx.X) as { n: number };
  expect(titles.n).toBe(260);
  expectRoomMatches(fx, fx.A);
});
