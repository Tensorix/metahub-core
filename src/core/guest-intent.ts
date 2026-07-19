// GuestIntent — the one high-level, idempotent shape a guest surface accepts for
// a write. The browser produces an intent ("create a record in table T with
// these values"); it NEVER mints a CRDT Change or an HLC. The server / DO / drop
// owner is the authority that turns an intent into oplog ops. This generalizes
// room-protocol's GuestWriteIntent (op/db/record/values) with an idempotency key
// (intentId) and a client-declared submit time (submittedAt).
//
// Two clock modes, one executor:
//   - "authority" (all realtime paths: site / share / room /api and room WS):
//     the executing node is the time authority. Delegates to grants-core's
//     guestCreateRecord/guestUpdateRecord — the ordinary emit path stamps the
//     node's own current HLC. Byte-identical to today's behavior.
//   - "submitted" (drop replay, Stage 4): the intent was sealed offline; its
//     ops must land on the GUEST node's own timeline at the client-declared
//     submitTime (clamped ≤ now+5min), so a Thursday-executed Tuesday submission
//     does NOT beat a Wednesday owner edit. That requires minting the guest's
//     HLC directly and applying via ingest() (NOT emit(), which would re-stamp
//     against the owner's shared clock — see hlc.nextHlc's Math.max floor).
//
// Idempotency: every intent's ops carry
// `intent:<guestNode>:<intentId>:<fingerprint>`. The guest scope prevents one
// visitor from claiming another visitor's key; the fingerprint rejects reuse of
// a key for a different request. Authorization is re-run before a receipt is
// returned, so revocation remains immediate.
//
// PORTABLE, driver-only.

import type { DbDriver } from "./driver.ts";
import { MhError } from "./errors.ts";
import { getDatabase } from "./databases.ts";
import { listProperties } from "./properties.ts";
import { coerce, resolveData, getRecord, type RecordRow } from "./records.ts";
import { formatHlc, parseHlc } from "./hlc.ts";
import { ingest, withTxnId, type Change } from "./crdt.ts";
import { randomSuffix } from "./ids.ts";
import type { AccessPolicy } from "./access-policy.ts";
import {
  authorizeDbRef,
  assertGuestPayload,
  guestCreateRecord,
  guestUpdateRecord,
  type GrantPrincipal,
} from "./grants-core.ts";

// Same clamp as drop-protocol's DROP_HLC_SKEW_MS — a submitted intent whose
// declared time is more than 5 min in the future is pulled back to now+5min, so
// a skewed/hostile client can't poison the future. Kept local (not imported) so
// this module doesn't pull the seal/drop stack into the room/DO bundle.
const HLC_SKEW_MS = 5 * 60_000;
const INTENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

export interface GuestIntent {
  v?: 1;
  /** Client-minted idempotency key (also the row id source for optimistic echo). */
  intentId: string;
  action: "createRecord" | "updateRecord";
  /** createRecord: database ref (id or granted name). */
  table?: string;
  /** updateRecord: existing record id. createRecord: the client-minted row id
   *  (so the optimistic echo and the eventual server row share an id). */
  recordId?: string;
  payload: Record<string, unknown>;
  /** epoch ms the client declares it submitted at (submitted-clock mode only). */
  submittedAt: number;
}

export interface GuestSession {
  /** Per-visitor guest node id every op is attributed to. */
  guestNode: string;
}

export interface ApplyIntentOpts {
  clock: "authority" | "submitted";
  now?: number;
}

interface PreparedIntent {
  fingerprint: string;
  /** Coerced, property-id-keyed cells in deterministic property-id order. */
  cells: { propId: string; value: unknown }[];
  databaseId: string;
  /** Updates retain the tombstoned row's database for current-policy auth, but
   *  a new write must still fail if the target is no longer live. */
  targetLive: boolean;
}

/**
 * Apply one guest intent, authorized + guarded by the policy, attributed to the
 * session's guest node. Idempotent on intentId. Returns the resulting record.
 * The caller is responsible for access gating (session validity, expiry,
 * password/Turnstile) BEFORE calling — this executor only authorizes grants and
 * guards the payload, exactly like guestCreateRecord/guestUpdateRecord.
 */
export function applyGuestIntent(
  db: DbDriver,
  policy: AccessPolicy,
  session: GuestSession,
  intent: GuestIntent,
  opts: ApplyIntentOpts,
): RecordRow {
  if (!INTENT_ID_RE.test(intent.intentId))
    throw new MhError("invalid_input", "intentId must be 1-64 safe characters");
  const principal: GrantPrincipal = { kind: policy.audience, guestNode: session.guestNode };
  const tx = db.transaction(() => {
    // Re-authorize and re-validate on EVERY attempt. In particular, a receipt
    // must never outlive the grant that made the original request legal.
    const prepared = prepareIntent(db, policy, principal, intent);
    const prefix = intentTxnPrefix(session.guestNode, intent.intentId);
    const txn = prefix + prepared.fingerprint;
    const receipt = receiptForPrefix(db, prefix);
    if (receipt) {
      if (receipt.txn !== txn)
        throw new MhError("conflict", "intentId was already used for a different request");
      const prior = getRecord(db, receipt.row_id);
      if (!prior) throw new MhError("conflict", "intent result no longer exists");
      return prior;
    }
    if (!prepared.targetLive) throw new MhError("auth", "unauthorized");

    if (opts.clock === "submitted")
      return applySubmitted(db, policy, principal, intent, prepared, txn, opts.now ?? Date.now());

    // Authority mode: the executing node's clock, via the ordinary emit path.
    return withTxnId(txn, () => applyAuthority(db, policy, principal, intent));
  });
  return tx();
}

/** Resolve grants and normalize/coerce the request before the idempotency probe.
 *  This makes the fingerprint semantic: table names and property names resolve
 *  to stable IDs, and equivalent coerced values hash identically. */
function prepareIntent(
  db: DbDriver,
  policy: AccessPolicy,
  principal: GrantPrincipal,
  intent: GuestIntent,
): PreparedIntent {
  if (intent.action === "createRecord") {
    if (!intent.table || typeof intent.table !== "string")
      throw new MhError("invalid_input", "createRecord intent needs a table");
    const database = authorizeDbRef(db, policy.grants, intent.table, "create");
    assertGuestPayload(db, policy.grants, principal, database, intent.payload, {
      limits: policy.limits,
    });
    const cells = resolvedCells(db, database.id, intent.payload);
    return {
      databaseId: database.id,
      cells,
      targetLive: true,
      fingerprint: fingerprintIntent("createRecord", database.id, intent.recordId ?? null, cells),
    };
  }

  if (!intent.recordId || typeof intent.recordId !== "string")
    throw new MhError("invalid_input", "updateRecord intent needs a record id");
  if (Object.keys(intent.payload).length === 0)
    throw new MhError("invalid_input", "updateRecord intent payload must not be empty");
  // Keep the database association of a tombstoned row available for current
  // policy authorization. This lets a replay whose result was deleted reach
  // the receipt check and return 409, while a revoked grant still fails first.
  const rec = db
    .query("SELECT database_id, __deleted FROM records WHERE id = ?")
    .get(intent.recordId) as { database_id: string | null; __deleted: number } | null;
  if (!rec?.database_id) throw new MhError("auth", "unauthorized");
  const database = authorizeDbRef(db, policy.grants, rec.database_id, "update");
  assertGuestPayload(db, policy.grants, principal, database, intent.payload, {
    limits: policy.limits,
  });
  const cells = resolvedCells(db, database.id, intent.payload);
  return {
    databaseId: database.id,
    cells,
    targetLive: rec.__deleted === 0,
    fingerprint: fingerprintIntent("updateRecord", database.id, intent.recordId, cells),
  };
}

function resolvedCells(
  db: DbDriver,
  databaseId: string,
  payload: Record<string, unknown>,
): PreparedIntent["cells"] {
  const props = listProperties(db, databaseId);
  return resolveData(props, payload)
    .map(({ prop, value }) => ({ propId: prop.id, value: coerce(db, prop, value) }))
    .sort((a, b) => (a.propId < b.propId ? -1 : a.propId > b.propId ? 1 : 0));
}

function applyAuthority(
  db: DbDriver,
  policy: AccessPolicy,
  principal: GrantPrincipal,
  intent: GuestIntent,
): RecordRow {
  if (intent.action === "createRecord") {
    if (!intent.table) throw new MhError("invalid_input", "createRecord intent needs a table");
    return guestCreateRecord(db, policy.grants, principal, intent.table, intent.payload, policy.limits);
  }
  if (!intent.recordId) throw new MhError("invalid_input", "updateRecord intent needs a record id");
  return guestUpdateRecord(db, policy.grants, principal, intent.recordId, intent.payload, policy.limits);
}

/** Submitted-clock: mint the guest's own-timeline ops and ingest() them, so the
 *  op HLCs carry the (clamped) submit time rather than the executor's now. */
function applySubmitted(
  db: DbDriver,
  policy: AccessPolicy,
  principal: GrantPrincipal,
  intent: GuestIntent,
  prepared: PreparedIntent,
  txn: string,
  now: number,
): RecordRow {
  const node = principal.guestNode;
  const millis = clampMillis(intent.submittedAt, now);

  if (intent.action === "createRecord") {
    const rowId = intent.recordId ?? "rec_" + randomSuffix(10);
    if (recordIdEverUsed(db, rowId))
      throw new MhError("conflict", "record id already exists");
    const database = getDatabase(db, prepared.databaseId);
    if (!database) throw new MhError("auth", "unauthorized");
    // The stateful row ceiling applies only to a fresh create. Exact retries
    // already returned their receipt above, even if the table filled later.
    assertGuestPayload(db, policy.grants, principal, database, intent.payload, {
      create: true,
      limits: policy.limits,
    });

    let counter = seedCounter(db, node, millis);
    const changes: Change[] = [];
    const firstHlc = formatHlc({ millis, counter, node });
    const mk = (col: string, value: unknown): void => {
      changes.push({
        hlc: formatHlc({ millis, counter, node }),
        node_id: node,
        dataset: "records",
        row_id: rowId,
        col,
        value: value == null ? null : JSON.stringify(value),
        txn,
      });
      counter++;
    };
    mk("database_id", prepared.databaseId);
    mk("created_hlc", firstHlc); // created_hlc's VALUE is the first op's HLC (drop parity)
    for (const cell of prepared.cells) mk(cell.propId, cell.value);
    ingest(db, changes);
    return getRecord(db, rowId)!;
  }

  let counter = seedCounter(db, node, millis);
  const changes: Change[] = prepared.cells.map(({ propId, value }) => {
    const c: Change = {
      hlc: formatHlc({ millis, counter, node }),
      node_id: node,
      dataset: "records",
      row_id: intent.recordId!,
      col: propId,
      value: value == null ? null : JSON.stringify(value),
      txn,
    };
    counter++;
    return c;
  });
  ingest(db, changes);
  return getRecord(db, intent.recordId!)!;
}

function clampMillis(submittedAt: number, now: number): number {
  const safeNow = Math.max(0, Math.trunc(Number.isFinite(now) ? now : Date.now()));
  const ceil = safeNow + HLC_SKEW_MS;
  if (!Number.isFinite(submittedAt)) return safeNow;
  return Math.max(0, Math.min(Math.trunc(submittedAt), ceil));
}

/** Counter to start a guest's ops at for `millis`, past any op it already has at
 *  that millisecond — so two intents in the same ms can't collide on the oplog
 *  UNIQUE (dataset,row_id,col,hlc) and silently drop a write. */
function seedCounter(db: DbDriver, node: string, millis: number): number {
  const prefix = String(millis).padStart(15, "0") + "-";
  const row = db
    .query("SELECT MAX(hlc) AS h FROM crdt_changes WHERE node_id = ? AND hlc LIKE ? || '%'")
    .get(node, prefix) as { h: string | null };
  return row.h ? parseHlc(row.h).counter + 1 : 0;
}

function intentTxnPrefix(guestNode: string, intentId: string): string {
  return `intent:${encodeURIComponent(guestNode)}:${intentId}:`;
}

/** Range lookup rather than LIKE: intentId excludes protocol separators and the
 *  txn index can satisfy the bounded prefix scan. */
function receiptForPrefix(
  db: DbDriver,
  prefix: string,
): { txn: string; row_id: string } | null {
  return db
    .query(
      `SELECT txn, row_id FROM crdt_changes
       WHERE dataset = 'records' AND txn >= ? AND txn < ?
       ORDER BY txn LIMIT 1`,
    )
    .get(prefix, prefix + "\uffff") as { txn: string; row_id: string } | null;
}

function recordIdEverUsed(db: DbDriver, rowId: string): boolean {
  if (db.query("SELECT 1 AS ok FROM records WHERE id = ? LIMIT 1").get(rowId) != null)
    return true;
  return (
    db
      .query("SELECT 1 AS ok FROM crdt_changes WHERE dataset = 'records' AND row_id = ? LIMIT 1")
      .get(rowId) != null
  );
}

function fingerprintIntent(
  action: GuestIntent["action"],
  databaseId: string,
  recordId: string | null,
  cells: PreparedIntent["cells"],
): string {
  const canonical = stableStringify({
    action,
    databaseId,
    recordId,
    cells: cells.map((c) => [c.propId, c.value]),
  });
  let h = FNV64_OFFSET;
  for (let i = 0; i < canonical.length; i++) {
    h ^= BigInt(canonical.charCodeAt(i));
    h = (h * FNV64_PRIME) & U64_MASK;
  }
  return h.toString(16).padStart(16, "0");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(obj)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + stableStringify(obj[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value) ?? "null";
}
