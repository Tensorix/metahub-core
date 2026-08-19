import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import { createDatabase } from "./databases.ts";
import { addProperty } from "./properties.ts";
import { createRecord, getRecord } from "./records.ts";
import { nextHlc } from "./hlc.ts";
import type { Change } from "./crdt.ts";
import {
  parseGrantSet,
  serializeGrantSet,
  validateGrantSetInput,
  parseGrantSpec,
  grantFor,
  grantAllows,
  grantSetHasWrite,
  publicGuestNode,
  authorizeDbRef,
  authorizeRecord,
  assertGuestPayload,
  guestCreateRecord,
  guestUpdateRecord,
  checkGuestChanges,
  GUEST_LIMITS,
  type GrantSet,
  type GrantPrincipal,
} from "./grants-core.ts";
import { MhError, errorCode } from "./errors.ts";

function makeDb(node = "hostnode"): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(node);
  return db;
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return errorCode(e);
  }
  return undefined;
}

const PUB: GrantPrincipal = { kind: "public", guestNode: "gp-testtest-hostnode" };
const SHARE: GrantPrincipal = { kind: "share", guestNode: "gabcdefgh-x1y2z3" };

function grants(...tables: GrantSet["tables"]): GrantSet {
  return { v: 1, tables };
}

// ---- parse: default-deny five poisons ------------------------------------------

test("parseGrantSet: the five poisons all yield the empty set (default-deny)", () => {
  const empty = { v: 1, tables: [] };
  expect(parseGrantSet(null)).toEqual(empty); // 1. null/undefined
  expect(parseGrantSet(undefined)).toEqual(empty);
  expect(parseGrantSet("not json {{{")).toEqual(empty); // 2. broken JSON
  expect(parseGrantSet(JSON.stringify({ v: 2, tables: [{ db: "db_x", ops: ["read"] }] }))).toEqual(empty); // 3. v≠1
  expect(parseGrantSet(JSON.stringify({ v: 1, tables: [{ db: "db_x", ops: ["read", "delete"] }] }))).toEqual(empty); // 4. unknown op (delete NEVER parses)
  expect(parseGrantSet(JSON.stringify({ v: 1, tables: { db: "db_x" } }))).toEqual(empty); // 5. malformed shape
  expect(parseGrantSet(JSON.stringify({ v: 1, tables: [{ db: 42, ops: ["read"] }] }))).toEqual(empty);
});

test("parseGrantSet round-trips a valid set; serialize canonicalizes", () => {
  const raw = JSON.stringify({
    v: 1,
    tables: [
      { db: "db_b", ops: ["update", "read", "read"] },
      { db: "db_a", ops: ["create"] },
      { db: "db_b", ops: ["create"] },
    ],
  });
  const set = parseGrantSet(raw);
  // merged + deduped + op order (read,create,update) + tables sorted by db id
  expect(set).toEqual({
    v: 1,
    tables: [
      { db: "db_a", ops: ["create"] },
      { db: "db_b", ops: ["read", "create", "update"] },
    ],
  });
  expect(parseGrantSet(serializeGrantSet(set))).toEqual(set);
});

test("validateGrantSetInput throws loudly where parseGrantSet silently denies", () => {
  expect(code(() => validateGrantSetInput({ v: 2, tables: [] }))).toBe("invalid_input");
  expect(code(() => validateGrantSetInput({ v: 1, tables: [{ db: "x", ops: ["delete"] }] }))).toBe("invalid_input");
  expect(validateGrantSetInput({ v: 1, tables: [{ db: "x", ops: ["read"] }] })).toEqual(
    grants({ db: "x", ops: ["read"] }),
  );
});

test("parseGrantSpec parses <db>:<ops>; junk throws invalid_input", () => {
  expect(parseGrantSpec("tasks:read,create")).toEqual({ db: "tasks", ops: ["read", "create"] });
  expect(parseGrantSpec("my:db:update")).toEqual({ db: "my:db", ops: ["update"] });
  expect(code(() => parseGrantSpec("tasks"))).toBe("invalid_input");
  expect(code(() => parseGrantSpec("tasks:"))).toBe("invalid_input");
  expect(code(() => parseGrantSpec("tasks:delete"))).toBe("invalid_input");
  expect(code(() => parseGrantSpec(":read"))).toBe("invalid_input");
});

test("grantFor/grantAllows/grantSetHasWrite basics", () => {
  const set = grants({ db: "db_a", ops: ["read"] });
  expect(grantFor(set, "db_a")?.ops).toEqual(["read"]);
  expect(grantAllows(set, "db_a", "read")).toBe(true);
  expect(grantAllows(set, "db_a", "create")).toBe(false);
  expect(grantAllows(set, "db_b", "read")).toBe(false);
  expect(grantSetHasWrite(set)).toBe(false);
  expect(grantSetHasWrite(grants({ db: "db_a", ops: ["create"] }))).toBe(true);
});

test("publicGuestNode derives per (site × node)", () => {
  const a = publicGuestNode("site_demo-abc123", "node1111");
  const b = publicGuestNode("site_demo-abc123", "node2222");
  const site8 = "site_demo-abc123".slice(-8);
  expect(a).toBe(`gp-${site8}-node1111`); // last 8 of the site id + first 8 of the node id
  expect(a).not.toBe(b);
  expect(a.startsWith(`gp-${site8}-`)).toBe(true); // LIKE 'gp-<site8>-%' groups a site's guests
});

// ---- authorize: uniform auth error (anti-enumeration) ---------------------------

test("authorizeDbRef: ungranted, nonexistent, and op-short all throw the identical auth error", () => {
  const db = makeDb();
  const real = createDatabase(db, { name: "Tasks" });
  const other = createDatabase(db, { name: "Secrets" });
  const set = grants({ db: real.id, ops: ["read"] });

  // granted: resolves by id AND by name (case-insensitive)
  expect(authorizeDbRef(db, set, real.id, "read").id).toBe(real.id);
  expect(authorizeDbRef(db, set, "tasks", "read").id).toBe(real.id);

  const errs = [
    code(() => authorizeDbRef(db, set, other.id, "read")), // exists, not granted
    code(() => authorizeDbRef(db, set, "db_ghost-000000", "read")), // does not exist
    code(() => authorizeDbRef(db, set, real.id, "create")), // granted, op missing
  ];
  expect(errs).toEqual(["auth", "auth", "auth"]);
  // message identical too (nothing to fingerprint)
  const msgs = new Set<string>();
  for (const ref of [other.id, "db_ghost-000000"]) {
    try {
      authorizeDbRef(db, set, ref, "read");
    } catch (e) {
      msgs.add((e as Error).message);
    }
  }
  expect(msgs.size).toBe(1);
});

test("authorizeRecord: nonexistent and ungranted answer identically; granted returns the row", () => {
  const db = makeDb();
  const a = createDatabase(db, { name: "A" });
  const b = createDatabase(db, { name: "B" });
  addProperty(db, a.id, { name: "Title", type: "text" });
  addProperty(db, b.id, { name: "Title", type: "text" });
  const recA = createRecord(db, a.id, { Title: "granted" });
  const recB = createRecord(db, b.id, { Title: "hidden" });
  const set = grants({ db: a.id, ops: ["read", "update"] });

  expect(authorizeRecord(db, set, recA.id, "read").values.Title).toBe("granted");
  expect(code(() => authorizeRecord(db, set, recB.id, "read"))).toBe("auth");
  expect(code(() => authorizeRecord(db, set, "rec_ghost-000000", "read"))).toBe("auth");
});

// ---- payload guardrails ------------------------------------------------------------

test("assertGuestPayload: relation forks on principal kind", () => {
  const db = makeDb();
  const people = createDatabase(db, { name: "People" });
  addProperty(db, people.id, { name: "Name", type: "text" });
  const tasks = createDatabase(db, { name: "Tasks" });
  addProperty(db, tasks.id, { name: "Title", type: "text" });
  addProperty(db, tasks.id, { name: "Owner", type: "relation", config: { database: people.id } });
  const person = createRecord(db, people.id, { Name: "Alice" });

  const both = grants({ db: tasks.id, ops: ["create"] }, { db: people.id, ops: ["read"] });
  const tasksOnly = grants({ db: tasks.id, ops: ["create"] });
  const dbRow = { ...tasks };

  // public principal: relations always refused
  expect(code(() => assertGuestPayload(db, both, PUB, dbRow, { Owner: person.id }))).toBe("invalid_input");
  // share principal: allowed when the target db is in the set…
  assertGuestPayload(db, both, SHARE, dbRow, { Owner: person.id });
  // …refused when it is not
  expect(code(() => assertGuestPayload(db, tasksOnly, SHARE, dbRow, { Owner: person.id }))).toBe("invalid_input");
  // clearing a relation (null / []) is fine for anyone
  assertGuestPayload(db, tasksOnly, PUB, dbRow, { Owner: null });
});

test("assertGuestPayload: the three size boundaries", () => {
  const db = makeDb();
  const d = createDatabase(db, { name: "D" });
  addProperty(db, d.id, { name: "Text", type: "text" });
  const set = grants({ db: d.id, ops: ["create"] });

  // 1. per-value cap
  const big = "x".repeat(GUEST_LIMITS.maxValueBytes + 1);
  expect(code(() => assertGuestPayload(db, set, PUB, d, { Text: big }))).toBe("invalid_input");
  // just inside passes (leave room for the JSON quotes)
  assertGuestPayload(db, set, PUB, d, { Text: "x".repeat(GUEST_LIMITS.maxValueBytes - 2) });

  // 2. cell-count cap
  const many: Record<string, unknown> = {};
  for (let i = 0; i <= GUEST_LIMITS.maxCells; i++) many[`c${i}`] = i;
  expect(code(() => assertGuestPayload(db, set, PUB, d, many))).toBe("invalid_input");

  // 3. total-body cap (many properties, each under the per-value cap)
  const tight = { ...GUEST_LIMITS, maxBodyBytes: 100, maxValueBytes: 90 };
  addProperty(db, d.id, { name: "Text2", type: "text" });
  expect(
    code(() =>
      assertGuestPayload(db, set, PUB, d, { Text: "x".repeat(60), Text2: "y".repeat(60) }, { limits: tight }),
    ),
  ).toBe("invalid_input");
});

// ---- guest writes -------------------------------------------------------------------

test("guestCreateRecord: attribution, coercion delegation, and the row ceiling", () => {
  const db = makeDb();
  const d = createDatabase(db, { name: "Guestbook" });
  addProperty(db, d.id, { name: "Msg", type: "text" });
  addProperty(db, d.id, { name: "N", type: "number" });
  const set = grants({ db: d.id, ops: ["create"] });

  const rec = guestCreateRecord(db, set, PUB, "guestbook", { Msg: "hello", N: "42" });
  expect(rec.values.Msg).toBe("hello");
  expect(rec.values.N).toBe(42); // coerce() normalized the string

  // every oplog row of the write carries the guest node id
  const nodes = db
    .query("SELECT DISTINCT node_id FROM crdt_changes WHERE dataset='records' AND row_id = ?")
    .all(rec.id) as { node_id: string }[];
  expect(nodes).toEqual([{ node_id: PUB.guestNode }]);

  // coercion failure surfaces as invalid_input (delegated to records.coerce)
  expect(code(() => guestCreateRecord(db, set, PUB, d.id, { N: "not-a-number" }))).toBe("invalid_input");

  // maxRows ceiling
  const tiny = { ...GUEST_LIMITS, maxRows: 1 };
  expect(code(() => guestCreateRecord(db, set, PUB, d.id, { Msg: "again" }, tiny))).toBe("invalid_input");

  // read/update not granted → both denied uniformly
  expect(code(() => authorizeDbRef(db, set, d.id, "read"))).toBe("auth");
  expect(code(() => guestUpdateRecord(db, set, PUB, rec.id, { Msg: "edit" }))).toBe("auth");
});

test("guestUpdateRecord: updates any row of a granted table under the guest identity", () => {
  const db = makeDb();
  const d = createDatabase(db, { name: "Ledger" });
  addProperty(db, d.id, { name: "Item", type: "text" });
  const mine = createRecord(db, d.id, { Item: "owner wrote this" });
  const set = grants({ db: d.id, ops: ["update"] });

  const updated = guestUpdateRecord(db, set, SHARE, mine.id, { Item: "guest edit" });
  expect(updated.values.Item).toBe("guest edit");
  expect(getRecord(db, mine.id)!.values.Item).toBe("guest edit");
  const node = db
    .query("SELECT node_id FROM crdt_changes WHERE dataset='records' AND row_id=? ORDER BY seq DESC LIMIT 1")
    .get(mine.id) as { node_id: string };
  expect(node.node_id).toBe(SHARE.guestNode);
});

// ---- checkGuestChanges (op-level, inbox ingest) -----------------------------------

const GUEST = "gguest123";

function guestChange(db: Database, partial: Partial<Change> & Pick<Change, "row_id" | "col">): Change {
  return {
    hlc: nextHlc(db, GUEST),
    node_id: GUEST,
    dataset: "records",
    value: null,
    txn: null,
    ...partial,
  } as Change;
}

function creationChanges(db: Database, dbId: string, rowId: string, cells: Record<string, unknown>): Change[] {
  const out: Change[] = [guestChange(db, { row_id: rowId, col: "database_id", value: JSON.stringify(dbId) })];
  out.push(guestChange(db, { row_id: rowId, col: "created_hlc", value: JSON.stringify(out[0]!.hlc) }));
  for (const [col, v] of Object.entries(cells))
    out.push(guestChange(db, { row_id: rowId, col, value: JSON.stringify(v) }));
  return out;
}

test("checkGuestChanges matrix: valid create passes; every violation trips", () => {
  const db = makeDb();
  const d = createDatabase(db, { name: "Inbox" });
  const msg = addProperty(db, d.id, { name: "Msg", type: "text" });
  const n = addProperty(db, d.id, { name: "N", type: "number" });
  const other = createDatabase(db, { name: "Other" });
  addProperty(db, other.id, { name: "X", type: "text" });
  const createOnly = grants({ db: d.id, ops: ["create"] });

  // valid create (row does not exist yet)
  checkGuestChanges(db, createOnly, GUEST, creationChanges(db, d.id, "rec_new-000001", { [msg.id]: "hi", [n.id]: 5 }));

  // wrong dataset
  expect(
    code(() =>
      checkGuestChanges(db, createOnly, GUEST, [
        guestChange(db, { row_id: "doc_x", col: "title", dataset: "documents", value: '"t"' }),
      ]),
    ),
  ).toBe("invalid_input");

  // node mismatch (node_id or HLC segment not the guest)
  const forged = creationChanges(db, d.id, "rec_new-000002", { [msg.id]: "hi" });
  forged[0] = { ...forged[0]!, node_id: "hostnode" };
  expect(code(() => checkGuestChanges(db, createOnly, GUEST, forged))).toBe("auth");
  const forgedHlc = creationChanges(db, d.id, "rec_new-000003", { [msg.id]: "hi" });
  forgedHlc[0] = { ...forgedHlc[0]!, hlc: forgedHlc[0]!.hlc.replace(GUEST, "hostnode") };
  expect(code(() => checkGuestChanges(db, createOnly, GUEST, forgedHlc))).toBe("auth");

  // tombstone
  expect(
    code(() =>
      checkGuestChanges(db, createOnly, GUEST, [
        guestChange(db, { row_id: "rec_new-000004", col: "__deleted", value: "1" }),
      ]),
    ),
  ).toBe("invalid_input");

  // ungranted target database
  expect(
    code(() => checkGuestChanges(db, createOnly, GUEST, creationChanges(db, other.id, "rec_new-000005", {}))),
  ).toBe("auth");

  // new row without database_id
  expect(
    code(() =>
      checkGuestChanges(db, createOnly, GUEST, [
        guestChange(db, { row_id: "rec_new-000006", col: msg.id, value: '"hi"' }),
      ]),
    ),
  ).toBe("invalid_input");

  // unknown column
  expect(
    code(() =>
      checkGuestChanges(
        db,
        createOnly,
        GUEST,
        creationChanges(db, d.id, "rec_new-000007", { prop_ghost: "x" }),
      ),
    ),
  ).toBe("invalid_input");

  // coercion failure (number property, non-numeric value)
  expect(
    code(() =>
      checkGuestChanges(db, createOnly, GUEST, creationChanges(db, d.id, "rec_new-000008", { [n.id]: "NaN!" })),
    ),
  ).toBe("invalid_input");

  // oversized value
  expect(
    code(() =>
      checkGuestChanges(
        db,
        createOnly,
        GUEST,
        creationChanges(db, d.id, "rec_new-000009", { [msg.id]: "x".repeat(GUEST_LIMITS.maxValueBytes + 1) }),
      ),
    ),
  ).toBe("invalid_input");
});

test("checkGuestChanges: create-only grant refuses ops against an EXISTING row; update grant accepts", () => {
  const db = makeDb();
  const d = createDatabase(db, { name: "Board" });
  const msg = addProperty(db, d.id, { name: "Msg", type: "text" });
  const existing = createRecord(db, d.id, { Msg: "already here" });

  const createOnly = grants({ db: d.id, ops: ["create"] });
  const withUpdate = grants({ db: d.id, ops: ["create", "update"] });
  const edit = [guestChange(db, { row_id: existing.id, col: msg.id, value: '"overwrite"' })];

  expect(code(() => checkGuestChanges(db, createOnly, GUEST, edit))).toBe("auth");
  checkGuestChanges(db, withUpdate, GUEST, edit); // passes

  // cross-database move is refused even with update
  const other = createDatabase(db, { name: "Elsewhere" });
  expect(
    code(() =>
      checkGuestChanges(db, withUpdate, GUEST, [
        guestChange(db, { row_id: existing.id, col: "database_id", value: JSON.stringify(other.id) }),
      ]),
    ),
  ).toBe("invalid_input");
});

// F10 parity guard: the op-ingest path (checkGuestChanges) must apply the SAME
// relation policy as the realtime granted API (assertRelationAllowed) — public
// forbids relations outright (resolving one probes the target db = an
// enumeration oracle); a share principal may write them, but only into a db
// that is itself in the set. Keeps the two guest-write transports from drifting.
test("checkGuestChanges relation policy matches the sync path: public forbids, share allows granted", () => {
  const db = makeDb();
  const people = createDatabase(db, { name: "P" });
  addProperty(db, people.id, { name: "Name", type: "text" });
  const tasks = createDatabase(db, { name: "T" });
  addProperty(db, tasks.id, { name: "Title", type: "text" });
  const owner = addProperty(db, tasks.id, { name: "Owner", type: "relation", config: { database: people.id } });
  const person = createRecord(db, people.id, { Name: "A" });

  const tasksOnly = grants({ db: tasks.id, ops: ["create"] });
  const both = grants({ db: tasks.id, ops: ["create"] }, { db: people.id, ops: ["read"] });
  const rel = creationChanges(db, tasks.id, "rec_new-100001", { [owner.id]: [person.id] });

  // public (the drop/write-inbox default) — relations refused even when granted.
  expect(code(() => checkGuestChanges(db, both, GUEST, rel, "public"))).toBe("invalid_input");
  expect(code(() => checkGuestChanges(db, both, GUEST, rel))).toBe("invalid_input"); // default is public
  // share — allowed into a granted target, refused into an ungranted one.
  checkGuestChanges(db, both, GUEST, rel, "share");
  expect(code(() => checkGuestChanges(db, tasksOnly, GUEST, rel, "share"))).toBe("invalid_input");

  // row ceiling (independent of relation policy; limits is the 6th arg now)
  const tiny = { ...GUEST_LIMITS, maxRows: 0 };
  expect(
    code(() =>
      checkGuestChanges(db, both, GUEST, creationChanges(db, tasks.id, "rec_new-100002", {}), "public", tiny),
    ),
  ).toBe("invalid_input");
});

test("assertGuestPayload: doc cells are never guest-writable", () => {
  const db = makeDb();
  const tasks = createDatabase(db, { name: "Tasks" });
  addProperty(db, tasks.id, { name: "Title", type: "text" });
  addProperty(db, tasks.id, { name: "Docs", type: "doc" });
  const set = grants({ db: tasks.id, ops: ["create", "update"] });

  // both principals refused — GrantSet cannot scope documents
  expect(code(() => assertGuestPayload(db, set, PUB, tasks, { Docs: ["doc_x-000000"] }))).toBe("invalid_input");
  expect(code(() => assertGuestPayload(db, set, SHARE, tasks, { Docs: ["doc_x-000000"] }))).toBe("invalid_input");
  // the rejection is policy, not resolution: an existing doc changes nothing
  // (the policy check runs before any resolve probe)
  expect(code(() => assertGuestPayload(db, set, SHARE, tasks, { Docs: "任意标题" }))).toBe("invalid_input");
  // clearing (null / []) is fine for anyone
  assertGuestPayload(db, set, PUB, tasks, { Docs: null });
  assertGuestPayload(db, set, SHARE, tasks, { Docs: [] });
});
