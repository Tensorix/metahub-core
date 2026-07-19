// GuestIntent — the one high-level, idempotent shape a guest surface accepts
// for a write. Browsers submit intent; the runtime owns authorization, clocks,
// CRDT emission and durable idempotency.
//
// Idempotency receipts are oplog-only CRDT registers. Unlike a txn lookup on
// business cells, history compaction cannot erase one during its replay window.
// The register follows normal oplog replication without adding a node-local
// table that would split idempotency state across runtimes; protocol GC removes
// it after that bounded window and replication filters prevent resurrection.
//
// PORTABLE, driver-only.

import type { DbDriver } from "./driver.ts";
import { MhError } from "./errors.ts";
import type { DatabaseRow } from "./databases.ts";
import {
  createRecordPrepared,
  getRecord,
  updateRecordPrepared,
  type PreparedRecordCell,
  type RecordRow,
} from "./records.ts";
import { formatHlc, parseHlc } from "./hlc.ts";
import { ingest, withNodeId, withTxnId, type Change } from "./crdt.ts";
import { randomSuffix } from "./ids.ts";
import { fnv1a64Hex } from "./hash.ts";
import {
  INTENT_RECEIPT_DATASET,
  intentSubmissionExpired,
  isExpiredIntentReceipt,
  pruneExpiredIntentReceipts,
} from "./intent-retention.ts";
import type { AccessPolicy } from "./access-policy.ts";
import {
  assertGuestCreateCapacity,
  assertGuestPayload,
  authorizeDbRef,
  grantAllows,
  type GrantPrincipal,
} from "./grants-core.ts";

// Same clamp as drop-protocol's DROP_HLC_SKEW_MS. Kept local so the portable
// runtime core does not pull the seal/drop stack into a Room bundle.
const HLC_SKEW_MS = 5 * 60_000;
const INTENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Kept as a public re-export for callers/tests that treat receipts as protocol state. */
export { INTENT_RECEIPT_DATASET } from "./intent-retention.ts";
const RECEIPT_COL = "result";

export interface GuestIntent {
  v?: 1;
  intentId: string;
  action: "createRecord" | "updateRecord";
  /** createRecord: database ref (id or granted name). */
  table?: string;
  /** updateRecord: target row. Submitted create: optional client row id. */
  recordId?: string;
  payload: Record<string, unknown>;
  /** Epoch ms used only by submitted-clock execution. */
  submittedAt: number;
}

export interface GuestSession {
  guestNode: string;
}

export interface ApplyIntentOpts {
  clock: "authority" | "submitted";
  now?: number;
}

interface PreparedIntent {
  action: GuestIntent["action"];
  database: DatabaseRow;
  /** Coerced once, preserving request order for authority-mode HLC parity. */
  cells: PreparedRecordCell[];
  fingerprint: string;
  /** A tombstoned update remains identifiable for receipt conflict handling. */
  targetLive: boolean;
}

interface IntentReceipt {
  v: 1;
  action: GuestIntent["action"];
  fingerprint: string;
  databaseId: string;
  recordId: string;
  /** Immutable write-only response; never gains fields from later owner edits. */
  result: RecordRow;
}

/**
 * Apply one guest intent atomically. Authorization and payload validation run
 * before every receipt lookup, so revocation is immediate. A matching receipt
 * returns the immutable submitted projection unless current policy also grants
 * read on the target table.
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

  const acceptedNow = opts.now ?? Date.now();
  // This maintenance runs outside the request transaction deliberately: even a
  // rejected stale replay must still be able to reclaim its expired receipt.
  pruneExpiredIntentReceipts(db, acceptedNow);
  const principal: GrantPrincipal = {
    kind: policy.audience,
    guestNode: session.guestNode,
  };
  const tx = db.transaction(() => {
    const prepared = prepareIntent(db, policy, principal, intent, opts.clock);
    const txn = intentTxnPrefix(session.guestNode, intent.intentId) + prepared.fingerprint;
    const receipt = readReceipt(
      db,
      session.guestNode,
      intent.intentId,
      acceptedNow,
    );

    if (receipt) {
      if (
        receipt.fingerprint !== prepared.fingerprint ||
        receipt.action !== prepared.action ||
        receipt.databaseId !== prepared.database.id
      )
        throw new MhError("conflict", "intentId was already used for a different request");

      const current = getRecord(db, receipt.recordId);
      if (!current || current.database_id !== receipt.databaseId)
        throw new MhError("conflict", "intent result no longer exists");
      return responseForPolicy(policy, current, receipt.result);
    }

    // A receipt that aged out must never turn a delayed replay back into a fresh
    // update. The inbox expires first, so legitimate first delivery remains
    // possible throughout its full retention period.
    if (
      opts.clock === "submitted" &&
      intentSubmissionExpired(intent.submittedAt, acceptedNow)
    )
      throw new MhError("conflict", "intent replay window expired");

    if (!prepared.targetLive) throw new MhError("auth", "unauthorized");

    if (opts.clock === "submitted")
      return applySubmitted(
        db,
        policy,
        principal,
        intent,
        prepared,
        txn,
        acceptedNow,
      );
    return applyAuthority(
      db,
      policy,
      principal,
      intent,
      prepared,
      txn,
      acceptedNow,
    );
  });
  return tx();
}

/** Resolve grants and normalize/coerce the request once before idempotency. */
function prepareIntent(
  db: DbDriver,
  policy: AccessPolicy,
  principal: GrantPrincipal,
  intent: GuestIntent,
  clock: ApplyIntentOpts["clock"],
): PreparedIntent {
  if (
    typeof intent.payload !== "object" ||
    intent.payload === null ||
    Array.isArray(intent.payload)
  )
    throw new MhError("invalid_input", "intent payload must be an object");

  if (intent.action === "createRecord") {
    if (!intent.table || typeof intent.table !== "string")
      throw new MhError("invalid_input", "createRecord intent needs a table");
    const database = authorizeDbRef(db, policy.grants, intent.table, "create");
    const cells = assertGuestPayload(
      db,
      policy.grants,
      principal,
      database,
      intent.payload,
      { limits: policy.limits },
    );
    return {
      action: intent.action,
      database,
      cells,
      targetLive: true,
      fingerprint: fingerprintIntent(
        intent.action,
        database.id,
        clock === "submitted" ? intent.recordId ?? null : null,
        cells,
      ),
    };
  }

  if (intent.action !== "updateRecord")
    throw new MhError("invalid_input", "unknown guest intent action");
  if (!intent.recordId || typeof intent.recordId !== "string")
    throw new MhError("invalid_input", "updateRecord intent needs a record id");
  if (Object.keys(intent.payload).length === 0)
    throw new MhError("invalid_input", "updateRecord intent payload must not be empty");

  // Tombstoned rows keep database_id, which lets a matching deleted replay
  // reach the receipt and return 409 while a revoked grant still fails first.
  const rec = db
    .query("SELECT database_id, __deleted FROM records WHERE id = ?")
    .get(intent.recordId) as { database_id: string | null; __deleted: number } | null;
  if (!rec?.database_id) throw new MhError("auth", "unauthorized");
  const database = authorizeDbRef(db, policy.grants, rec.database_id, "update");
  const cells = assertGuestPayload(
    db,
    policy.grants,
    principal,
    database,
    intent.payload,
    { limits: policy.limits },
  );
  return {
    action: intent.action,
    database,
    cells,
    targetLive: rec.__deleted === 0,
    fingerprint: fingerprintIntent(intent.action, database.id, intent.recordId, cells),
  };
}

function applyAuthority(
  db: DbDriver,
  policy: AccessPolicy,
  principal: GrantPrincipal,
  intent: GuestIntent,
  prepared: PreparedIntent,
  txn: string,
  acceptedNow: number,
): RecordRow {
  return withTxnId(txn, () =>
    withNodeId(principal.guestNode, () => {
      if (intent.action === "createRecord")
        assertGuestCreateCapacity(db, prepared.database, policy.limits);
      const current =
        intent.action === "createRecord"
          ? createRecordPrepared(db, prepared.database, prepared.cells)
          : updateRecordPrepared(db, intent.recordId!, prepared.cells);
      const projection = submittedProjection(
        current.id,
        prepared.database.id,
        prepared.cells,
      );
      writeReceiptAt(
        db,
        principal.guestNode,
        intent.intentId,
        makeReceipt(intent.action, prepared, current.id, projection),
        txn,
        acceptedNow,
      );
      return responseForPolicy(policy, current, projection);
    }),
  );
}

/** Submitted-clock: mint business ops and receipt on the guest's timeline. */
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
  const cells = [...prepared.cells].sort((a, b) =>
    a.prop.id < b.prop.id ? -1 : a.prop.id > b.prop.id ? 1 : 0,
  );
  const rowId =
    intent.action === "createRecord"
      ? intent.recordId ?? "rec_" + randomSuffix(10)
      : intent.recordId!;

  if (intent.action === "createRecord" && recordIdEverUsed(db, rowId))
    throw new MhError("conflict", "record id already exists");
  if (intent.action === "createRecord")
    assertGuestCreateCapacity(db, prepared.database, policy.limits);

  let counter = seedCounter(db, node, millis);
  const changes: Change[] = [];
  const mk = (dataset: string, targetId: string, col: string, value: unknown): string => {
    const hlc = formatHlc({ millis, counter, node });
    counter++;
    changes.push({
      hlc,
      node_id: node,
      dataset,
      row_id: targetId,
      col,
      value: value == null ? null : JSON.stringify(value),
      txn,
    });
    return hlc;
  };

  if (intent.action === "createRecord") {
    const firstHlc = formatHlc({ millis, counter, node });
    mk("records", rowId, "database_id", prepared.database.id);
    mk("records", rowId, "created_hlc", firstHlc);
  }
  for (const cell of cells) mk("records", rowId, cell.prop.id, cell.value);

  const projection = submittedProjection(rowId, prepared.database.id, cells);
  const receipt = makeReceipt(intent.action, prepared, rowId, projection);
  // Retention is based on when the runtime accepted the intent, not on the
  // guest-supplied submittedAt. Otherwise a last-moment Drop delivery could
  // create a receipt that is immediately old enough to collect.
  const receiptMillis = clampMillis(now, now);
  const receiptCounter =
    receiptMillis === millis ? counter : seedCounter(db, node, receiptMillis);
  changes.push({
    hlc: formatHlc({ millis: receiptMillis, counter: receiptCounter, node }),
    node_id: node,
    dataset: INTENT_RECEIPT_DATASET,
    row_id: receiptRowId(node, intent.intentId),
    col: RECEIPT_COL,
    value: JSON.stringify(receipt),
    txn,
  });
  ingest(db, changes, { now: receiptMillis });

  const current = getRecord(db, rowId);
  if (!current) throw new MhError("conflict", "intent result no longer exists");
  return responseForPolicy(policy, current, projection);
}

function responseForPolicy(
  policy: AccessPolicy,
  current: RecordRow,
  projection: RecordRow,
): RecordRow {
  return grantAllows(policy.grants, current.database_id, "read") ? current : projection;
}

function submittedProjection(
  recordId: string,
  databaseId: string,
  cells: PreparedRecordCell[],
): RecordRow {
  const values: Record<string, unknown> = {};
  const byId: Record<string, unknown> = {};
  for (const { prop, value } of cells) {
    values[prop.name] = value;
    byId[prop.id] = value;
  }
  return { id: recordId, database_id: databaseId, values, cells: byId };
}

function makeReceipt(
  action: GuestIntent["action"],
  prepared: PreparedIntent,
  recordId: string,
  result: RecordRow,
): IntentReceipt {
  return {
    v: 1,
    action,
    fingerprint: prepared.fingerprint,
    databaseId: prepared.database.id,
    recordId,
    result,
  };
}

/** Receipt age is protocol wall time, independent of a possibly-ahead CRDT
 * clock observed from peers. Its coordinate is unique, so it need not be above
 * unrelated business registers to remain a durable winner. */
function writeReceiptAt(
  db: DbDriver,
  guestNode: string,
  intentId: string,
  receipt: IntentReceipt,
  txn: string,
  acceptedNow: number,
): void {
  const millis = clampMillis(acceptedNow, acceptedNow);
  const change: Change = {
    hlc: formatHlc({
      millis,
      counter: seedCounter(db, guestNode, millis),
      node: guestNode,
    }),
    node_id: guestNode,
    dataset: INTENT_RECEIPT_DATASET,
    row_id: receiptRowId(guestNode, intentId),
    col: RECEIPT_COL,
    value: JSON.stringify(receipt),
    txn,
  };
  ingest(db, [change], { now: millis });
}

function readReceipt(
  db: DbDriver,
  guestNode: string,
  intentId: string,
  now: number,
): IntentReceipt | null {
  const row = db
    .query(
      `SELECT hlc, value, node_id, txn FROM crdt_changes
       WHERE dataset = ? AND row_id = ? AND col = ?
       ORDER BY hlc DESC LIMIT 1`,
    )
    .get(
      INTENT_RECEIPT_DATASET,
      receiptRowId(guestNode, intentId),
      RECEIPT_COL,
    ) as {
      hlc: string;
      value: string | null;
      node_id: string;
      txn: string | null;
    } | null;
  if (!row) return null;
  if (
    isExpiredIntentReceipt(
      { dataset: INTENT_RECEIPT_DATASET, hlc: row.hlc },
      now,
    )
  )
    return null;

  try {
    const receipt = JSON.parse(row.value ?? "") as Partial<IntentReceipt>;
    if (
      row.node_id !== guestNode ||
      receipt.v !== 1 ||
      (receipt.action !== "createRecord" && receipt.action !== "updateRecord") ||
      typeof receipt.fingerprint !== "string" ||
      !/^[0-9a-f]{16}$/.test(receipt.fingerprint) ||
      row.txn !== intentTxnPrefix(guestNode, intentId) + receipt.fingerprint ||
      typeof receipt.databaseId !== "string" ||
      typeof receipt.recordId !== "string" ||
      !isRecordRow(receipt.result) ||
      receipt.result.id !== receipt.recordId ||
      receipt.result.database_id !== receipt.databaseId
    )
      throw new Error("invalid receipt");
    return receipt as IntentReceipt;
  } catch {
    throw new MhError("conflict", "intent receipt is invalid");
  }
}

function isRecordRow(value: unknown): value is RecordRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<RecordRow>;
  return (
    typeof row.id === "string" &&
    typeof row.database_id === "string" &&
    !!row.values &&
    typeof row.values === "object" &&
    !Array.isArray(row.values) &&
    !!row.cells &&
    typeof row.cells === "object" &&
    !Array.isArray(row.cells)
  );
}

function clampMillis(submittedAt: number, now: number): number {
  const safeNow = Math.max(0, Math.trunc(Number.isFinite(now) ? now : Date.now()));
  const ceil = safeNow + HLC_SKEW_MS;
  if (!Number.isFinite(submittedAt)) return safeNow;
  return Math.max(0, Math.min(Math.trunc(submittedAt), ceil));
}

/** Start after all guest ops already minted at this millisecond. */
function seedCounter(db: DbDriver, node: string, millis: number): number {
  const prefix = String(millis).padStart(15, "0") + "-";
  const row = db
    .query("SELECT MAX(hlc) AS h FROM crdt_changes WHERE node_id = ? AND hlc LIKE ? || '%'")
    .get(node, prefix) as { h: string | null };
  return row.h ? parseHlc(row.h).counter + 1 : 0;
}

export function intentTxnPrefix(guestNode: string, intentId: string): string {
  return `intent:${encodeURIComponent(guestNode)}:${intentId}:`;
}

function receiptRowId(guestNode: string, intentId: string): string {
  return `${encodeURIComponent(guestNode)}:${intentId}`;
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
  cells: PreparedRecordCell[],
): string {
  const canonical = stableStringify({
    action,
    databaseId,
    recordId,
    cells: [...cells]
      .sort((a, b) => (a.prop.id < b.prop.id ? -1 : a.prop.id > b.prop.id ? 1 : 0))
      .map((cell) => [cell.prop.id, cell.value]),
  });
  return fnv1a64Hex(canonical);
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
