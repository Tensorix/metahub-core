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
// Idempotency: every intent's ops carry txn "intent:<intentId>". A retried
// submission (dropped response, drop replay) probes to the already-applied row
// instead of double-creating.
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
  authorizeRecord,
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
  const txn = "intent:" + intent.intentId;
  const prior = recordForTxn(db, txn);
  if (prior) return prior; // idempotent replay — already applied

  const principal: GrantPrincipal = { kind: policy.audience, guestNode: session.guestNode };
  if (opts.clock === "submitted")
    return applySubmitted(db, policy, principal, intent, txn, opts.now ?? Date.now());

  // Authority mode: the executing node's clock, via the ordinary emit path.
  return withTxnId(txn, () => applyAuthority(db, policy, principal, intent));
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
  txn: string,
  now: number,
): RecordRow {
  const set = policy.grants;
  const node = principal.guestNode;
  const millis = clampMillis(intent.submittedAt, now);

  if (intent.action === "createRecord") {
    if (!intent.table) throw new MhError("invalid_input", "createRecord intent needs a table");
    const database = authorizeDbRef(db, set, intent.table, "create");
    assertGuestPayload(db, set, principal, database, intent.payload, { create: true, limits: policy.limits });
    const rowId = intent.recordId ?? "rec_" + randomSuffix(10);
    const props = listProperties(db, database.id);
    const resolved = resolveData(props, intent.payload);

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
    mk("database_id", database.id);
    mk("created_hlc", firstHlc); // created_hlc's VALUE is the first op's HLC (drop parity)
    for (const { prop, value } of resolved) mk(prop.id, coerce(db, prop, value));
    ingest(db, changes);
    return getRecord(db, rowId)!;
  }

  if (!intent.recordId) throw new MhError("invalid_input", "updateRecord intent needs a record id");
  const rec = authorizeRecord(db, set, intent.recordId, "update");
  const database = getDatabase(db, rec.database_id);
  if (!database) throw new MhError("auth", "unauthorized");
  assertGuestPayload(db, set, principal, database, intent.payload, { limits: policy.limits });
  const props = listProperties(db, database.id);
  const resolved = resolveData(props, intent.payload);

  let counter = seedCounter(db, node, millis);
  const changes: Change[] = resolved.map(({ prop, value }) => {
    const c: Change = {
      hlc: formatHlc({ millis, counter, node }),
      node_id: node,
      dataset: "records",
      row_id: intent.recordId!,
      col: prop.id,
      value: (() => {
        const v = coerce(db, prop, value);
        return v == null ? null : JSON.stringify(v);
      })(),
      txn,
    };
    counter++;
    return c;
  });
  ingest(db, changes);
  return getRecord(db, intent.recordId)!;
}

function clampMillis(submittedAt: number, now: number): number {
  const ceil = now + HLC_SKEW_MS;
  if (!Number.isFinite(submittedAt)) return now;
  return Math.min(submittedAt, ceil);
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

/** The record last written under a txn (idempotency probe), or null. */
function recordForTxn(db: DbDriver, txn: string): RecordRow | null {
  const row = db
    .query("SELECT row_id FROM crdt_changes WHERE txn = ? AND dataset = 'records' LIMIT 1")
    .get(txn) as { row_id: string } | null;
  return row ? getRecord(db, row.row_id) : null;
}
