// AccessPolicy — the one internal shape describing "who may do what through a
// guest surface". Today the authorization state of a guest surface is scattered
// across three stores with different lifetimes:
//   - public sites → sites.public_grants (a synced CRDT register) + drop_knobs
//     (node-local meta) for the Turnstile/password write gate;
//   - share links → shares.grants / pw_hash / pw_salt / expires_at columns;
//   - DO rooms    → room_config.grants / pwHash / pwSalt / expiresAt (JSON).
//
// AccessPolicy is a READ-ONLY projection over those stores (a facade — this
// module does NOT migrate storage; that is a later stage). The three resolvers
// below each read their own store and return the identical shape, so the guest
// serving path (serveGrantedApi) can be driven by policy instead of hand-wiring
// grants + knobs per mount. Isolation is preserved: each site / share slug /
// room resolves to its OWN policy — resolvers never merge across surfaces.
//
// PORTABLE, driver-only (no node:/bun:) — the same resolver runs on this node's
// server and inside the workerd DO room adapter.

import type { DbDriver } from "./driver.ts";
import type { GrantSet, GrantPrincipal, PayloadLimits } from "./grants-core.ts";
import { parseGrantSet, GUEST_LIMITS } from "./grants-core.ts";
import { verifyPasswordVerifier } from "./shares.ts";

/** The Turnstile / password write gate, normalized from whichever store holds
 *  it. Both are optional; absent = open submission for that factor. */
export interface WriteGate {
  turnstile?: { sitekey?: string; secret?: string };
  /** PBKDF2 verifier + its published salt (the password itself never travels). */
  password?: { saltB64: string; verifierB64: string };
}

export interface AccessPolicy {
  /** Gates the relation-write policy in assertGuestPayload (public forbids). */
  audience: GrantPrincipal["kind"]; // "public" | "share"
  grants: GrantSet;
  writeGate: WriteGate;
  limits: PayloadLimits;
  /** Monotonic policy version — 0 until Stage 5 wires real revisions. */
  revision: number;
  /** epoch ms; null = never expires. */
  expiresAt: number | null;
  /** Base guest node id every write is attributed under (per-visitor sub ids
   *  hang off it); null on the public site surface (derived per serving node). */
  guestBase: string | null;
}

/**
 * A deterministic fingerprint of a policy's ENFORCEABLE content (grants, write
 * gate presence, expiry, audience) — the manifest's policyRevision. Node-
 * independent (any node computes the same value for the same policy state) and
 * changes iff the policy changes, so an SDK/publisher can detect "the policy
 * moved" by comparing revisions. NOT a monotonic counter: a revert to a prior
 * policy yields the prior revision, which is the right behavior for change
 * detection. FNV-1a-32 over a canonical string (grants are already normalized +
 * sorted by parseGrantSet, so the string is stable).
 */
export function computeRevision(policy: Pick<AccessPolicy, "audience" | "grants" | "writeGate" | "expiresAt">): number {
  const canon = JSON.stringify({
    a: policy.audience,
    t: policy.grants.tables,
    ts: !!policy.writeGate.turnstile?.secret,
    pw: !!policy.writeGate.password,
    x: policy.expiresAt ?? null,
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) {
    h ^= canon.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** Verify a candidate password against a policy's write gate (constant-time,
 *  same PBKDF2 params as share unlock). No password gate → always true. */
export async function verifyPolicyPassword(policy: AccessPolicy, password: string): Promise<boolean> {
  const pw = policy.writeGate.password;
  if (!pw) return true;
  return verifyPasswordVerifier(pw.verifierB64, pw.saltB64, password);
}

/** Shape needed to resolve a site policy without importing the whole site row
 *  reader here (keeps this module free of sites-core's heavier deps). */
export interface SitePolicySource {
  publicGrants: string | null;
  /** From getDropKnobs(db, siteId) — may be null. */
  knobs: {
    turnstileSitekey?: string;
    turnstileSecret?: string;
    passwordSalt?: string;
    passwordVerifier?: string;
  } | null;
}

/** Public site policy: grants from the synced register, write gate from the
 *  node-local drop knobs. No expiry (a site is public until unpublished);
 *  guestBase null (publicGuestNode is derived per serving node by the caller). */
export function policyForSite(src: SitePolicySource): AccessPolicy {
  return withRevision({
    audience: "public",
    grants: parseGrantSet(src.publicGrants),
    writeGate: gateFromKnobs(src.knobs),
    limits: GUEST_LIMITS,
    revision: 0,
    expiresAt: null,
    guestBase: null,
  });
}

/** Shape needed to resolve a share policy (a subset of ShareRow). */
export interface SharePolicySource {
  grants: string | null;
  pw_salt: string | null;
  pw_hash: string | null;
  expires_at: number | null;
  guest_node_id: string | null;
}

/** Share-link policy: grants + password from the node-local share row. A share
 *  has no Turnstile gate (the capability slug + optional password IS the gate). */
export function policyForShare(src: SharePolicySource): AccessPolicy {
  return withRevision({
    audience: "share",
    grants: parseGrantSet(src.grants),
    writeGate: passwordGate(src.pw_salt, src.pw_hash),
    limits: GUEST_LIMITS,
    revision: 0,
    expiresAt: src.expires_at,
    guestBase: src.guest_node_id,
  });
}

/** Shape needed to resolve a room policy (a subset of RoomConfig). */
export interface RoomPolicySource {
  grants: string;
  pwHash?: string | null;
  pwSalt?: string | null;
  expiresAt?: number | null;
  guestBase: string;
}

/** DO-room policy: same shape, sourced from the room config JSON. */
export function policyForRoom(src: RoomPolicySource): AccessPolicy {
  return withRevision({
    audience: "share",
    grants: parseGrantSet(src.grants),
    writeGate: passwordGate(src.pwSalt ?? null, src.pwHash ?? null),
    limits: GUEST_LIMITS,
    revision: 0,
    expiresAt: src.expiresAt ?? null,
    guestBase: src.guestBase,
  });
}

/** Stamp a freshly-assembled policy with its content revision. */
function withRevision(p: AccessPolicy): AccessPolicy {
  p.revision = computeRevision(p);
  return p;
}

function gateFromKnobs(knobs: SitePolicySource["knobs"]): WriteGate {
  const gate: WriteGate = {};
  if (knobs?.turnstileSecret || knobs?.turnstileSitekey)
    gate.turnstile = { sitekey: knobs.turnstileSitekey, secret: knobs.turnstileSecret };
  // The write gate compares x-drop-pass against the VERIFIER (constant-time);
  // the salt is only published so the page can derive the verifier client-side,
  // so the verifier alone arms the gate (saltB64 empty if not yet stored).
  if (knobs?.passwordVerifier)
    gate.password = { saltB64: knobs.passwordSalt ?? "", verifierB64: knobs.passwordVerifier };
  return gate;
}

function passwordGate(saltB64: string | null, verifierB64: string | null): WriteGate {
  return saltB64 && verifierB64 ? { password: { saltB64, verifierB64 } } : {};
}

// Deliberately no db-reading resolver here (policyForSiteId(db, id)): that would
// pull sites-core + edge-config into this portable module. Callers assemble the
// SitePolicySource from getSite + getDropKnobs at the (non-portable) mount and
// hand it to policyForSite — see sites-serve.ts.
