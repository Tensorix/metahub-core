import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { getServerConfig, setServerConfig, DEFAULT_CONFIG } from "../config.ts";
import {
  generatePairingCode,
  redeemPairingCode,
  mintGrant,
  isAcceptedGrant,
  handlePairRequest,
  listGrants,
  revokeGrant,
} from "./pairing.ts";
import { getPeer, addPeer, removePeer } from "./peers.ts";
import { type AuthConfig, acceptsSyncToken } from "./auth.ts";
import { loadOrRotate } from "./token.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  runSchema(db);
  return db;
}

const DAY = 86_400_000;
const managed = (db: Database): AuthConfig => ({
  debug: false,
  staticToken: null,
  db,
  ttlMs: 30 * DAY,
  graceMs: 7 * DAY,
});

function post(url: string, token?: string): [Request, URL] {
  const u = new URL(url);
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  return [new Request(u, { method: "POST", headers }), u];
}

// --- config -----------------------------------------------------------------

test("config: defaults then round-trips a partial update", () => {
  const db = makeDb();
  expect(getServerConfig(db)).toEqual(DEFAULT_CONFIG);
  setServerConfig(db, { port: 9000, autoSync: false });
  const c = getServerConfig(db);
  expect(c.port).toBe(9000);
  expect(c.autoSync).toBe(false);
  expect(c.host).toBe(DEFAULT_CONFIG.host); // untouched fields keep defaults
});

// --- pairing codes ----------------------------------------------------------

test("pairing code: single-use", () => {
  const db = makeDb();
  const { code } = generatePairingCode(db, 60_000);
  expect(redeemPairingCode(db, code)).toBe(true);
  expect(redeemPairingCode(db, code)).toBe(false); // already used
});

test("pairing code: rejects expired and unknown", () => {
  const db = makeDb();
  const { code } = generatePairingCode(db, -1); // already expired
  expect(redeemPairingCode(db, code)).toBe(false);
  expect(redeemPairingCode(db, "nope")).toBe(false);
});

// --- grants -----------------------------------------------------------------

test("mintGrant is accepted; random tokens are not", () => {
  const db = makeDb();
  const g = mintGrant(db, "http://b:7778", "nodeB");
  expect(isAcceptedGrant(db, g)).toBe(true);
  expect(isAcceptedGrant(db, "garbage")).toBe(false);
});

test("listGrants and revokeGrant (exact and prefix, incl. null peer_url)", () => {
  const db = makeDb();
  const g1 = mintGrant(db, "http://b", "nodeB");
  const g2 = mintGrant(db, null, "nodeC"); // one-directional pairing: no peer_url
  expect(listGrants(db).map((g) => g.token).sort()).toEqual([g1, g2].sort());

  // exact revoke
  expect(revokeGrant(db, g1)).toBe(1);
  expect(isAcceptedGrant(db, g1)).toBe(false);

  // prefix revoke reaches the null-peer_url grant (removePeer cannot)
  expect(revokeGrant(db, g2.slice(0, 6))).toBe(1);
  expect(isAcceptedGrant(db, g2)).toBe(false);
  expect(listGrants(db)).toHaveLength(0);
});

// --- sync gate --------------------------------------------------------------

test("acceptsSyncToken: master token, any grant, reject unknown", () => {
  const db = makeDb();
  const cfg = managed(db);
  const master = loadOrRotate(db, 30 * DAY, 7 * DAY).token;
  const grant = mintGrant(db, "http://b", "nodeB");

  expect(acceptsSyncToken(...post("http://x/sync", master), cfg, db)).toBe(true);
  expect(acceptsSyncToken(...post("http://x/sync", grant), cfg, db)).toBe(true);
  expect(acceptsSyncToken(...post("http://x/sync", "wrong"), cfg, db)).toBe(false);
  expect(acceptsSyncToken(...post("http://x/sync"), cfg, db)).toBe(false);
});

test("acceptsSyncToken: debug mode lets everything through", () => {
  const db = makeDb();
  const cfg: AuthConfig = { debug: true, staticToken: null, db: null, ttlMs: 0, graceMs: 0 };
  expect(acceptsSyncToken(...post("http://x/sync"), cfg, db)).toBe(true);
});

// --- full handshake (two in-memory nodes, bypassing the network) ------------

test("handshake: both sides accept each other's sync tokens and register peers", () => {
  const dbA = makeDb(); // the server being paired with
  const dbB = makeDb(); // the device initiating
  const urlA = "http://a:7777";
  const urlB = "http://b:7778";

  // A mints a one-time code (printed in A's terminal).
  const { code } = generatePairingCode(dbA, 60_000);

  // B's outbound half (what performPairing does, minus the fetch): mint a grant
  // for A, then hand the request to A's inbound handler.
  const grantFromB = mintGrant(dbB, urlA, null);
  const resp = handlePairRequest(dbA, "nodeA", {
    code,
    node_id: "nodeB",
    grant: grantFromB,
    self_url: urlB,
  });
  addPeer(dbB, { url: urlA, token: resp.grant, node_id: resp.node_id });

  // B → A: B presents A's grant; A accepts it.
  expect(getPeer(dbB, urlA)?.token).toBe(resp.grant);
  expect(acceptsSyncToken(...post("http://a/sync", resp.grant), managed(dbA), dbA)).toBe(true);

  // A → B: A was registered with B's grant; B accepts it.
  expect(getPeer(dbA, urlB)?.token).toBe(grantFromB);
  expect(acceptsSyncToken(...post("http://b/sync", grantFromB), managed(dbB), dbB)).toBe(true);

  // The code is now spent.
  expect(redeemPairingCode(dbA, code)).toBe(false);

  // Removing the peer on A revokes the grant A issued (inbound /sync access)
  // and drops A's outbound peer row — a full mutual disconnect.
  removePeer(dbA, urlB);
  expect(getPeer(dbA, urlB)).toBeNull();
  expect(acceptsSyncToken(...post("http://a/sync", resp.grant), managed(dbA), dbA)).toBe(false);
});
