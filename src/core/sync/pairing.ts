// Device pairing: bootstrap a mutual trust relationship between two nodes using
// a short-lived one-time code, then exchange durable per-peer credentials
// ("certificates"). The master server token is never shared.
//
//   A: generatePairingCode()         -> CODE (printed in A's terminal / UI)
//   B: performPairing(A-url, CODE)   -> calls POST {A-url}/api/pair
//   A: handlePairRequest(...)        -> redeems CODE, mints+returns a grant
//
// After the handshake each side holds a grant it ISSUED (stored in peer_grants,
// accepted on /sync) and a grant it RECEIVED (stored in peers.token, presented
// when syncing out). See acceptsSyncToken in ./auth.ts and syncWithPeer.

import type { DbDriver } from "../driver.ts";
import { randomSuffix } from "../ids.ts";
import { parseDuration } from "./token.ts";
import { addPeer } from "./peers.ts";
import { PAIR_PATH, type PairRequest, type PairResponse } from "./protocol.ts";
import { MhError } from "../errors.ts";

/** Default one-time pairing-code lifetime (override with METAHUB_PAIR_TTL). */
export const DEFAULT_PAIR_TTL_MS = parseDuration(process.env.METAHUB_PAIR_TTL, 10 * 60_000);

export interface PairingCode {
  code: string;
  exp: number;
}

/** Mint a one-time pairing code, stored until redeemed or expired. */
export function generatePairingCode(db: DbDriver, ttlMs: number = DEFAULT_PAIR_TTL_MS): PairingCode {
  const now = Date.now();
  // Opportunistic housekeeping: drop spent/expired codes so the table can't grow.
  db.query("DELETE FROM pairing_codes WHERE used = 1 OR exp < ?").run(now);
  const code = randomSuffix(12); // ~62 bits; brute-forcing within the TTL is infeasible
  const exp = now + ttlMs;
  db.query(
    "INSERT INTO pairing_codes (code, exp, used, created_at) VALUES (?, ?, 0, ?)",
  ).run(code, exp, now);
  return { code, exp };
}

/**
 * Validate and consume a pairing code. The check-and-consume is a single atomic
 * UPDATE (guarded on used=0 AND not-expired) so two concurrent redemptions of
 * the same code can't both succeed. Returns false if unknown/used/expired.
 */
export function redeemPairingCode(db: DbDriver, code: string): boolean {
  return (
    db
      .query("UPDATE pairing_codes SET used = 1 WHERE code = ? AND used = 0 AND exp >= ?")
      .run(code, Date.now()).changes > 0
  );
}

/** Mint a durable credential we issue to a peer and will accept on /sync. */
export function mintGrant(db: DbDriver, peerUrl: string | null, nodeId: string | null): string {
  const token = randomSuffix(32);
  db.query(
    "INSERT INTO peer_grants (token, peer_url, node_id, created_at) VALUES (?, ?, ?, ?)",
  ).run(token, peerUrl, nodeId, Date.now());
  return token;
}

/** Whether a presented token matches a credential we issued during pairing. */
export function isAcceptedGrant(db: DbDriver, token: string): boolean {
  return db.query("SELECT 1 FROM peer_grants WHERE token = ?").get(token) != null;
}

export interface GrantRow {
  token: string;
  peer_url: string | null;
  node_id: string | null;
  created_at: number | null;
}

/** All credentials we have issued and still accept on /sync (inbound access). */
export function listGrants(db: DbDriver): GrantRow[] {
  return db
    .query("SELECT token, peer_url, node_id, created_at FROM peer_grants ORDER BY created_at DESC")
    .all() as GrantRow[];
}

/**
 * Revoke issued credentials by exact token or a unique prefix (handy for the
 * grants minted by one-directional pairing, which removePeer can't reach since
 * they have a null peer_url). Returns the number of grants revoked.
 */
export function revokeGrant(db: DbDriver, tokenOrPrefix: string): number {
  return db
    .query("DELETE FROM peer_grants WHERE token = ? OR token LIKE ? || '%'")
    .run(tokenOrPrefix, tokenOrPrefix).changes;
}

/**
 * Inbound side (device A): redeem the caller's one-time code, mint a grant for
 * the caller, register the caller back as a peer if it gave a reachable URL.
 */
export function handlePairRequest(db: DbDriver, node: string, body: PairRequest): PairResponse {
  if (!redeemPairingCode(db, body.code)) {
    throw new MhError("auth", "invalid or expired pairing code");
  }
  // The caller's grant lets us sync OUT to it; store it as our peer token.
  if (body.self_url) {
    addPeer(db, { url: body.self_url, token: body.grant, node_id: body.node_id });
  }
  // Mint a grant the caller will present when syncing IN to us.
  const grant = mintGrant(db, body.self_url ?? null, body.node_id);
  return { node_id: node, grant };
}

export interface PairOutcome {
  /** The paired peer's node id. */
  node_id: string;
  url: string;
}

/**
 * Outbound side (device B): mint a grant for the remote, post the handshake to
 * its /api/pair, then register it as a peer with the grant it returned.
 */
export async function performPairing(
  db: DbDriver,
  node: string,
  remoteUrl: string,
  code: string,
  selfUrl?: string,
): Promise<PairOutcome> {
  // Our grant lets the remote sync OUT to us; we store it so we accept it.
  const ourGrant = mintGrant(db, remoteUrl, null);
  const reqBody: PairRequest = { code, node_id: node, grant: ourGrant, self_url: selfUrl };

  const res = await fetch(new URL(PAIR_PATH, remoteUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reqBody),
  });
  if (!res.ok)
    throw new MhError(
      res.status === 401 || res.status === 403 ? "auth" : "network",
      `pairing failed: ${res.status} ${await res.text()}`,
    );

  const data = (await res.json()) as PairResponse;
  // The remote's grant lets us sync OUT to it; store it as our peer token.
  addPeer(db, { url: remoteUrl, token: data.grant, node_id: data.node_id });
  return { node_id: data.node_id, url: remoteUrl };
}
