// Write-inbox (drop) wire protocol: envelope/payload types, codecs, and the
// ingest-side isolation check. The inbox is a data-blind write face — the dual
// of the bucket's data-blind read face: visitors seal pre-signed ops to the
// owner's public key, the edge host stores ciphertext, and the owner's device
// decrypts + validates + ingests. An envelope is "mail", never "data", until
// checkDropPayload lets it through.
//
// PORTABLE: driver-only imports. The SDK (src/sdk/drop.ts) uses the light half
// (ids, codec, sealDropEnvelope); the owner's pull loop (drop-pull.ts) adds
// openDropEnvelope + checkDropPayload. Keep the halves import-separable so the
// browser SDK bundle never drags grants-core in (build.ts asserts this).

import type { DbDriver } from "../driver.ts";
import { MhError } from "../errors.ts";
import { randomSuffix } from "../ids.ts";
import { parseHlc } from "../hlc.ts";
import type { Change } from "../crdt.ts";
import { checkGuestChanges, type GrantSet } from "../grants-core.ts";
import type { GuestIntent } from "../guest-intent.ts"; // type-only: no runtime pull into the SDK bundle
import { toB64, fromB64 } from "./e2ee.ts";
import { seal, openSealed, SEAL_ENC } from "./seal.ts";

// ---- constants -------------------------------------------------------------------

/** Hard ceiling a serialized envelope may weigh (edge enforces 413 above it). */
export const DROP_ENVELOPE_MAX_BYTES = 64 * 1024;
/** Reject any change whose HLC claims to be further in the future than this —
 *  ingest() observeHlc's every change unconditionally, so an unclamped remote
 *  timestamp would permanently poison the local clock (design.md §7 red line 6). */
export const DROP_HLC_SKEW_MS = 5 * 60_000;
/** Inbox guest identity: "g" + 8 base36, minted per visitor, localStorage-persisted.
 *  9 chars total — structurally distinct from real 8-char node ids. */
export const GUEST_NODE_RE = /^g[0-9a-z]{8}$/;

// ---- types -----------------------------------------------------------------------

export interface DropEnvelope {
  v: 1;
  /** "e" + 16 base36 — replay-stable identity; also keys the txn rewrite. */
  envelope_id: string;
  /** The drop this was addressed to (site id today; "sh_"+slug reserved). */
  drop_id: string;
  enc: typeof SEAL_ENC;
  /** Which recipient key sealed it (drop-keys keyring key_id). */
  key_id: string;
  /** base64(MH-SEAL-P256 sealed DropPayload JSON). */
  sealed: string;
  /** Sender wall clock, epoch ms (informational only — never trusted). */
  created_at: number;
}

export interface DropPayload {
  v: 1;
  /** The visitor's guest node id ("g"+8) — every change must be signed by it. */
  guest_node: string;
  /** Pre-signed ops in oplog row format, authored under guest_node's mini-HLC. */
  changes: Change[];
  meta?: Record<string, unknown>;
}

/** Payload v2: high-level GuestIntents instead of pre-signed Change[]. The
 *  browser no longer mints HLC/oplog rows — the owner's applyGuestIntent does,
 *  on the guest's own timeline at each intent's (clamped) submittedAt. Idempotent
 *  on intentId (a replay under a new envelope_id is a no-op). This is where the
 *  guest-clock-minting attack surface (NaN-HLC, seed offsets) stops existing. */
export interface DropPayloadV2 {
  v: 2;
  guest_node: string;
  intents: GuestIntent[];
  meta?: Record<string, unknown>;
}

/** Either wire version — decodeDropPayload returns this; callers discriminate on `v`. */
export type AnyDropPayload = DropPayload | DropPayloadV2;

export function newEnvelopeId(): string {
  return "e" + randomSuffix(16);
}

export function newGuestNode(): string {
  return "g" + randomSuffix(8);
}

// ---- codec -----------------------------------------------------------------------

export function encodeDropPayload(payload: AnyDropPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

export function decodeDropPayload(bytes: Uint8Array): AnyDropPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new MhError("invalid_input", "drop payload is not JSON");
  }
  const p = parsed as { v?: unknown; guest_node?: unknown } | null;
  if (!p || typeof p !== "object" || typeof p.guest_node !== "string")
    throw new MhError("invalid_input", "malformed drop payload");
  if (p.v === 2) return decodeV2(p as Partial<DropPayloadV2>);
  if (p.v === 1) return decodeV1(p as Partial<DropPayload>);
  throw new MhError("invalid_input", "unknown drop payload version");
}

function decodeV1(p: Partial<DropPayload>): DropPayload {
  if (!Array.isArray(p.changes)) throw new MhError("invalid_input", "malformed drop payload");
  for (const c of p.changes) {
    if (
      !c ||
      typeof c !== "object" ||
      typeof c.hlc !== "string" ||
      typeof c.node_id !== "string" ||
      typeof c.dataset !== "string" ||
      typeof c.row_id !== "string" ||
      typeof c.col !== "string" ||
      !(c.value === null || typeof c.value === "string")
    )
      throw new MhError("invalid_input", "malformed change in drop payload");
  }
  return p as DropPayload;
}

function decodeV2(p: Partial<DropPayloadV2>): DropPayloadV2 {
  if (!Array.isArray(p.intents)) throw new MhError("invalid_input", "malformed drop payload");
  for (const i of p.intents) {
    const it = i as Partial<GuestIntent> | null;
    if (
      !it ||
      typeof it !== "object" ||
      typeof it.intentId !== "string" ||
      (it.action !== "createRecord" && it.action !== "updateRecord") ||
      typeof it.payload !== "object" ||
      it.payload === null ||
      Array.isArray(it.payload) ||
      typeof it.submittedAt !== "number"
    )
      throw new MhError("invalid_input", "malformed intent in drop payload");
  }
  return p as DropPayloadV2;
}

/** Structural check on an envelope as it comes off the edge host. */
export function parseDropEnvelope(raw: unknown): DropEnvelope {
  const e = raw as Partial<DropEnvelope> | null;
  if (
    !e ||
    typeof e !== "object" ||
    e.v !== 1 ||
    typeof e.envelope_id !== "string" ||
    e.envelope_id === "" ||
    typeof e.drop_id !== "string" ||
    e.enc !== SEAL_ENC ||
    typeof e.key_id !== "string" ||
    typeof e.sealed !== "string" ||
    typeof e.created_at !== "number"
  )
    throw new MhError("invalid_input", "malformed drop envelope");
  return e as DropEnvelope;
}

/** Seal a payload into a complete envelope (sender side — the SDK). */
export async function sealDropEnvelope(opts: {
  dropId: string;
  keyId: string;
  /** Recipient public key, raw uncompressed P-256 point. */
  pk: Uint8Array;
  payload: AnyDropPayload;
  now?: number;
}): Promise<DropEnvelope> {
  const sealed = await seal(opts.pk, encodeDropPayload(opts.payload));
  return {
    v: 1,
    envelope_id: newEnvelopeId(),
    drop_id: opts.dropId,
    enc: SEAL_ENC,
    key_id: opts.keyId,
    sealed: toB64(sealed),
    created_at: opts.now ?? Date.now(),
  };
}

/** Decrypt + decode an envelope with one keyring key (owner side). Wrong key /
 *  tampered ciphertext → MhError("auth") from openSealed. */
export async function openDropEnvelope(
  env: DropEnvelope,
  key: { pk: Uint8Array; sk: Uint8Array },
): Promise<AnyDropPayload> {
  const plain = await openSealed(key.sk, key.pk, fromB64(env.sealed));
  return decodeDropPayload(plain);
}

/** Validate a v2 payload's guest identity before its intents are applied
 *  (mirrors checkDropPayload's guest_node guard; per-intent authorization +
 *  minting is applyGuestIntent's job in drop-pull). */
export function checkDropIntents(ownNode: string, payload: DropPayloadV2): DropPayloadV2 {
  if (!GUEST_NODE_RE.test(payload.guest_node) || payload.guest_node === ownNode)
    throw new MhError("auth", "unauthorized");
  if (payload.intents.length === 0) throw new MhError("invalid_input", "empty drop payload");
  return payload;
}

// ---- ingest isolation check --------------------------------------------------------

/**
 * The write-inbox isolation layer: validate a decrypted payload BEFORE any of
 * it touches the oplog. Any violation throws (MhError) and the WHOLE envelope
 * is rejected — a form submission is atomic, partial ingest would strand half
 * a row. Checks, in order:
 *   1. guest_node has the inbox shape ("g"+8) and is not this node's own id —
 *      an envelope can never impersonate a real device;
 *   2. changes is non-empty;
 *   3. HLC clamp: every change's millis ≤ now + 5min (clock-poisoning guard —
 *      this is the one check that lives HERE rather than in grants-core,
 *      because it is clock hygiene, not authorization);
 *   4. grant semantics via grants-core.checkGuestChanges (records-only, node
 *      segment match, granted tables/ops, coercible property types — blob-
 *      carrying types refused, value coercion, size/row ceilings).
 * Returns the changes with txn force-rewritten to "drop:"+envelope_id, so
 * replays are stable (oplog UNIQUE dedups) and history can group + roll back
 * by envelope.
 */
export function checkDropPayload(
  db: DbDriver,
  set: GrantSet,
  ownNode: string,
  envelopeId: string,
  payload: DropPayload,
  now = Date.now(),
): Change[] {
  const guest = payload.guest_node;
  if (!GUEST_NODE_RE.test(guest) || guest === ownNode)
    throw new MhError("auth", "unauthorized");
  if (payload.changes.length === 0)
    throw new MhError("invalid_input", "empty drop payload");
  for (const c of payload.changes) {
    // A non-numeric HLC prefix parses to NaN; `NaN > x` is false, which would
    // sail past this future-clamp and (via observeHlc) poison the owner's clock.
    // Reject non-finite millis explicitly.
    const millis = parseHlc(c.hlc).millis;
    if (!Number.isFinite(millis) || millis > now + DROP_HLC_SKEW_MS)
      throw new MhError("invalid_input", "change HLC is malformed or too far in the future");
  }
  // A write-inbox drop is a site's public_grants surface → public principal
  // (relations forbidden, mirroring the realtime granted API).
  checkGuestChanges(db, set, guest, payload.changes, "public");
  return payload.changes.map((c) => ({ ...c, txn: "drop:" + envelopeId }));
}
