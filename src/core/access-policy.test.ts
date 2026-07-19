import { test, expect } from "bun:test";
import { hashSharePassword } from "./shares.ts";
import {
  policyForSite,
  policyForShare,
  policyForRoom,
  verifyPolicyPassword,
  computeRevision,
} from "./access-policy.ts";

test("policyForSite: grants from register, write gate from knobs, public audience, no expiry", () => {
  const p = policyForSite({
    publicGrants: JSON.stringify({ v: 1, tables: [{ db: "db1", ops: ["create"] }] }),
    knobs: { turnstileSitekey: "sk", turnstileSecret: "secret", passwordSalt: "s", passwordVerifier: "v" },
  });
  expect(p.audience).toBe("public");
  expect(p.grants.tables).toEqual([{ db: "db1", ops: ["create"] }]);
  expect(p.writeGate.turnstile).toEqual({ sitekey: "sk", secret: "secret" });
  expect(p.writeGate.password).toEqual({ saltB64: "s", verifierB64: "v" });
  expect(p.expiresAt).toBeNull();
  expect(p.guestBase).toBeNull();
  expect(typeof p.revision).toBe("number"); // content fingerprint (see revision test)
});

test("policyForSite: default-deny on malformed grants, empty gate when no knobs", () => {
  const p = policyForSite({ publicGrants: "not json", knobs: null });
  expect(p.grants.tables).toEqual([]); // parseGrantSet default-deny
  expect(p.writeGate).toEqual({});
});

test("policyForShare: grants + password from row, share audience, carries expiry + guestBase", () => {
  const p = policyForShare({
    grants: JSON.stringify({ v: 1, tables: [{ db: "db2", ops: ["read", "create"] }] }),
    pw_salt: "salt64",
    pw_hash: "verif64",
    expires_at: 1234,
    guest_node_id: "gbase",
  });
  expect(p.audience).toBe("share");
  expect(p.grants.tables[0]!.ops).toEqual(["read", "create"]);
  expect(p.writeGate.password).toEqual({ saltB64: "salt64", verifierB64: "verif64" });
  expect(p.writeGate.turnstile).toBeUndefined(); // shares have no turnstile gate
  expect(p.expiresAt).toBe(1234);
  expect(p.guestBase).toBe("gbase");
});

test("policyForRoom: grants + password from config JSON, share audience", () => {
  const p = policyForRoom({
    grants: JSON.stringify({ v: 1, tables: [{ db: "db3", ops: ["update"] }] }),
    pwHash: "h",
    pwSalt: "s",
    expiresAt: null,
    guestBase: "groom",
  });
  expect(p.audience).toBe("share");
  expect(p.grants.tables[0]!.ops).toEqual(["update"]);
  expect(p.writeGate.password).toEqual({ saltB64: "s", verifierB64: "h" });
  expect(p.guestBase).toBe("groom");
});

test("verifyPolicyPassword: true when no gate; correct/incorrect against a real verifier", async () => {
  const noGate = policyForSite({ publicGrants: null, knobs: null });
  expect(await verifyPolicyPassword(noGate, "anything")).toBe(true);

  const { salt, hash } = await hashSharePassword("s3cr3t");
  const gated = policyForShare({
    grants: null,
    pw_salt: salt,
    pw_hash: hash,
    expires_at: null,
    guest_node_id: null,
  });
  expect(await verifyPolicyPassword(gated, "s3cr3t")).toBe(true);
  expect(await verifyPolicyPassword(gated, "wrong")).toBe(false);
});

test("revision: deterministic fingerprint follows the client-observable policy", () => {
  const base = () =>
    policyForSite({ publicGrants: JSON.stringify({ v: 1, tables: [{ db: "d", ops: ["create"] }] }), knobs: null });
  // Stable + node-independent: same content → same revision.
  expect(base().revision).toBe(base().revision);
  expect(base().revision).not.toBe(0);

  // A grant change → a different revision.
  const widened = policyForSite({
    publicGrants: JSON.stringify({ v: 1, tables: [{ db: "d", ops: ["create", "update"] }] }),
    knobs: null,
  });
  expect(widened.revision).not.toBe(base().revision);

  // Adding a write gate → a different revision.
  const gated = policyForSite({
    publicGrants: JSON.stringify({ v: 1, tables: [{ db: "d", ops: ["create"] }] }),
    knobs: { passwordVerifier: "v" },
  });
  expect(gated.revision).not.toBe(base().revision);

  const passwordRotated = policyForSite({
    publicGrants: JSON.stringify({ v: 1, tables: [{ db: "d", ops: ["create"] }] }),
    knobs: { passwordSalt: "new-salt", passwordVerifier: "new-verifier" },
  });
  expect(passwordRotated.revision).not.toBe(gated.revision);
  const passwordSecretOnlyRotation = policyForSite({
    publicGrants: JSON.stringify({ v: 1, tables: [{ db: "d", ops: ["create"] }] }),
    knobs: { passwordSalt: "new-salt", passwordVerifier: "another-verifier" },
  });
  expect(passwordSecretOnlyRotation.revision).toBe(passwordRotated.revision);

  const turnstileA = policyForSite({
    publicGrants: JSON.stringify({ v: 1, tables: [{ db: "d", ops: ["create"] }] }),
    knobs: { turnstileSitekey: "site-a", turnstileSecret: "secret-a" },
  });
  const turnstileB = policyForSite({
    publicGrants: JSON.stringify({ v: 1, tables: [{ db: "d", ops: ["create"] }] }),
    knobs: { turnstileSitekey: "site-b", turnstileSecret: "secret-b" },
  });
  const secretOnlyRotation = policyForSite({
    publicGrants: JSON.stringify({ v: 1, tables: [{ db: "d", ops: ["create"] }] }),
    knobs: { turnstileSitekey: "site-a", turnstileSecret: "rotated-secret" },
  });
  expect(turnstileB.revision).not.toBe(turnstileA.revision);
  expect(secretOnlyRotation.revision).toBe(turnstileA.revision);

  const expiring = policyForShare({
    grants: JSON.stringify({ v: 1, tables: [{ db: "d", ops: ["create"] }] }),
    pw_salt: null,
    pw_hash: null,
    expires_at: 1234,
    guest_node_id: "g",
  });
  const extended = policyForShare({
    grants: JSON.stringify({ v: 1, tables: [{ db: "d", ops: ["create"] }] }),
    pw_salt: null,
    pw_hash: null,
    expires_at: 5678,
    guest_node_id: "g",
  });
  expect(extended.revision).not.toBe(expiring.revision);

  // A revert to the original content restores the original revision (content
  // fingerprint, not a monotonic counter — the right behavior for change detection).
  expect(computeRevision(base())).toBe(computeRevision(base()));
});

test("isolation: a site policy and a share policy over the same table never merge", () => {
  const site = policyForSite({
    publicGrants: JSON.stringify({ v: 1, tables: [{ db: "shared", ops: ["read"] }] }),
    knobs: null,
  });
  const share = policyForShare({
    grants: JSON.stringify({ v: 1, tables: [{ db: "shared", ops: ["read", "create", "update"] }] }),
    pw_salt: null,
    pw_hash: null,
    expires_at: null,
    guest_node_id: "g",
  });
  // Same db id, independent grant sets — resolving one must not widen the other.
  expect(site.grants.tables[0]!.ops).toEqual(["read"]);
  expect(share.grants.tables[0]!.ops).toEqual(["read", "create", "update"]);
});
