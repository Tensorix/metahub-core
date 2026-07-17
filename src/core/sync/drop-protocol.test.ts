import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { createDatabase } from "../databases.ts";
import { addProperty } from "../properties.ts";
import { createRecord } from "../records.ts";
import type { Change } from "../crdt.ts";
import { errorCode } from "../errors.ts";
import type { GrantSet } from "../grants-core.ts";
import { generateSealKeypair } from "./seal.ts";
import {
  newEnvelopeId,
  newGuestNode,
  GUEST_NODE_RE,
  encodeDropPayload,
  decodeDropPayload,
  parseDropEnvelope,
  sealDropEnvelope,
  openDropEnvelope,
  checkDropPayload,
  DROP_HLC_SKEW_MS,
  type DropPayload,
} from "./drop-protocol.ts";

const OWN_NODE = "hostnode";

function makeDb(): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(OWN_NODE);
  return db;
}

function hlcAt(millis: number, counter: number, node: string): string {
  return `${String(millis).padStart(15, "0")}-${counter.toString(16).padStart(4, "0")}-${node}`;
}

interface Fixture {
  db: Database;
  dbId: string;
  titleProp: string;
  set: GrantSet;
}

function fixture(ops: ("read" | "create" | "update")[] = ["create"]): Fixture {
  const db = makeDb();
  const table = createDatabase(db, { name: "guestbook" });
  const title = addProperty(db, table.id, { name: "Title", type: "text" });
  return { db, dbId: table.id, titleProp: title.id, set: { v: 1, tables: [{ db: table.id, ops }] } };
}

function createChanges(f: Fixture, guest: string, opts: { millis?: number; hlcNode?: string } = {}): Change[] {
  const millis = opts.millis ?? Date.now();
  const node = opts.hlcNode ?? guest;
  const rowId = "rec_" + guest;
  return [
    { hlc: hlcAt(millis, 0, node), node_id: guest, dataset: "records", row_id: rowId, col: "database_id", value: JSON.stringify(f.dbId), txn: "evil" },
    { hlc: hlcAt(millis, 1, node), node_id: guest, dataset: "records", row_id: rowId, col: "created_hlc", value: JSON.stringify(hlcAt(millis, 0, node)) },
    { hlc: hlcAt(millis, 2, node), node_id: guest, dataset: "records", row_id: rowId, col: f.titleProp, value: JSON.stringify("hi") },
  ];
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return errorCode(e);
  }
  return undefined;
}

// ---- ids / codec -------------------------------------------------------------------

test("id shapes: envelope e+16, guest g+8", () => {
  expect(newEnvelopeId()).toMatch(/^e[0-9a-z]{16}$/);
  expect(newGuestNode()).toMatch(GUEST_NODE_RE);
});

test("payload codec roundtrips; junk is invalid_input", () => {
  const p: DropPayload = { v: 1, guest_node: "gabcdefgh", changes: [] };
  expect(decodeDropPayload(encodeDropPayload(p))).toEqual(p);
  expect(code(() => decodeDropPayload(new TextEncoder().encode("not json")))).toBe("invalid_input");
  expect(code(() => decodeDropPayload(new TextEncoder().encode('{"v":2}')))).toBe("invalid_input");
  expect(
    code(() => decodeDropPayload(new TextEncoder().encode('{"v":1,"guest_node":"g1","changes":[{"hlc":1}]}'))),
  ).toBe("invalid_input");
});

test("v2 payload codec: intents roundtrip; malformed intent is invalid_input", () => {
  const p = {
    v: 2 as const,
    guest_node: "gabcdefgh",
    intents: [
      { intentId: "int_1", action: "createRecord" as const, table: "db1", payload: { c: 1 }, submittedAt: 123 },
    ],
  };
  expect(decodeDropPayload(encodeDropPayload(p))).toEqual(p);
  // missing intentId / bad action / non-object payload / non-number submittedAt all reject
  expect(code(() => decodeDropPayload(new TextEncoder().encode('{"v":2,"guest_node":"g1","intents":[{"action":"createRecord","payload":{},"submittedAt":1}]}')))).toBe("invalid_input");
  expect(code(() => decodeDropPayload(new TextEncoder().encode('{"v":2,"guest_node":"g1","intents":[{"intentId":"i","action":"nope","payload":{},"submittedAt":1}]}')))).toBe("invalid_input");
  expect(code(() => decodeDropPayload(new TextEncoder().encode('{"v":2,"guest_node":"g1","intents":"x"}')))).toBe("invalid_input");
  // unknown version rejects
  expect(code(() => decodeDropPayload(new TextEncoder().encode('{"v":9,"guest_node":"g1"}')))).toBe("invalid_input");
});

test("seal→open envelope roundtrip; envelope shape is validated", async () => {
  const kp = await generateSealKeypair();
  const payload: DropPayload = {
    v: 1,
    guest_node: "gabcdefgh",
    changes: [
      { hlc: hlcAt(5, 0, "gabcdefgh"), node_id: "gabcdefgh", dataset: "records", row_id: "r1", col: "c1", value: null },
    ],
  };
  const env = await sealDropEnvelope({ dropId: "site_x", keyId: "k1", pk: kp.publicKey, payload });
  expect(env.v).toBe(1);
  expect(env.drop_id).toBe("site_x");
  expect(env.enc).toBe("sealed-p256");
  expect(env.envelope_id).toMatch(/^e[0-9a-z]{16}$/);
  expect(parseDropEnvelope(JSON.parse(JSON.stringify(env)))).toEqual(env);
  expect(code(() => parseDropEnvelope({ ...env, enc: "rot13" }))).toBe("invalid_input");
  expect(code(() => parseDropEnvelope(null))).toBe("invalid_input");
  const opened = await openDropEnvelope(env, { pk: kp.publicKey, sk: kp.privateKey });
  expect(opened).toEqual(payload);
});

// ---- checkDropPayload matrix ----------------------------------------------------------

test("valid create passes and txn is force-rewritten to drop:<envelope_id>", () => {
  const f = fixture(["create"]);
  const guest = "gvalidone";
  const payload: DropPayload = { v: 1, guest_node: guest, changes: createChanges(f, guest) };
  const out = checkDropPayload(f.db, f.set, OWN_NODE, "e123", payload);
  expect(out).toHaveLength(3);
  for (const c of out) expect(c.txn).toBe("drop:e123");
  // the attacker-supplied txn ("evil") never survives
  expect(out.some((c) => c.txn === "evil")).toBe(false);
});

test("HLC too far in the future rejects the WHOLE envelope", () => {
  const f = fixture(["create"]);
  const guest = "gfuturist";
  const now = Date.now();
  const changes = createChanges(f, guest, { millis: now + DROP_HLC_SKEW_MS + 60_000 });
  expect(code(() => checkDropPayload(f.db, f.set, OWN_NODE, "e1", { v: 1, guest_node: guest, changes }, now))).toBe(
    "invalid_input",
  );
  // just inside the clamp is fine
  const ok = createChanges(f, guest, { millis: now + DROP_HLC_SKEW_MS - 1000 });
  expect(checkDropPayload(f.db, f.set, OWN_NODE, "e2", { v: 1, guest_node: guest, changes: ok }, now)).toHaveLength(3);
});

test("HLC node segment must match the guest node", () => {
  const f = fixture(["create"]);
  const guest = "gsegments";
  const changes = createChanges(f, guest, { hlcNode: "gsomebody" }); // node_id ok, hlc segment forged
  expect(code(() => checkDropPayload(f.db, f.set, OWN_NODE, "e1", { v: 1, guest_node: guest, changes }))).toBe("auth");
});

test("impersonating a real node is refused", () => {
  const f = fixture(["create"]);
  // guest_node equal to the host node id (fails the g+8 shape AND the own-node check)
  const c1 = createChanges(f, OWN_NODE);
  expect(code(() => checkDropPayload(f.db, f.set, OWN_NODE, "e1", { v: 1, guest_node: OWN_NODE, changes: c1 }))).toBe(
    "auth",
  );
  // a g-shaped guest that IS this node's id (hypothetical g-named host) still refused
  const gHost = "ghostnode";
  const c2 = createChanges(f, gHost);
  expect(code(() => checkDropPayload(f.db, f.set, gHost, "e1", { v: 1, guest_node: gHost, changes: c2 }))).toBe("auth");
  // malformed guest shapes
  for (const bad of ["", "xyz", "g", "gABCDEFGH", "gabcdefghi"]) {
    expect(code(() => checkDropPayload(f.db, f.set, OWN_NODE, "e1", { v: 1, guest_node: bad, changes: [] }))).toBe(
      "auth",
    );
  }
});

test("grant semantics ride checkGuestChanges: ungranted db / no-create / tombstone all refuse", () => {
  const guest = "ggranted1";
  // create against a db with only read granted
  const readOnly = fixture(["read"]);
  expect(
    code(() =>
      checkDropPayload(readOnly.db, readOnly.set, OWN_NODE, "e1", {
        v: 1,
        guest_node: guest,
        changes: createChanges(readOnly, guest),
      }),
    ),
  ).toBe("auth");
  // tombstone op is never guest-writable
  const f = fixture(["create", "update"]);
  const rec = createRecord(f.db, f.dbId, { Title: "target" });
  const del: Change[] = [
    { hlc: hlcAt(Date.now(), 0, guest), node_id: guest, dataset: "records", row_id: rec.id, col: "__deleted", value: "1" },
  ];
  expect(code(() => checkDropPayload(f.db, f.set, OWN_NODE, "e1", { v: 1, guest_node: guest, changes: del }))).toBe(
    "invalid_input",
  );
  // empty payload
  expect(code(() => checkDropPayload(f.db, f.set, OWN_NODE, "e1", { v: 1, guest_node: guest, changes: [] }))).toBe(
    "invalid_input",
  );
});
