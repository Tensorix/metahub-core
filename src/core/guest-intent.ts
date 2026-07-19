// GuestIntent — the one high-level, idempotent shape a guest surface accepts
// for a write. Browsers submit intent; the runtime owns authorization, clocks,
// CRDT emission and durable idempotency.
//
// Idempotency receipts are oplog-only CRDT registers. Unlike a txn lookup on
// business cells, a receipt is never superseded, so history compaction cannot
// erase it. The register also follows normal oplog replication without adding
// a node-local table that would split idempotency state across runtimes.
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
import { emit, ingest, withNodeId, withTxnId, type Change } from "./crdt.ts";
import { randomSuffix } from "./ids.ts";
import { fnv1a64Hex } from "./hash.ts";
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

/** Oplog-only dataset: materialize() deliberately ignores unknown datasets. */
export const INTENT_RECEIPT_DATASET = "intent_receipts";
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

  const principal: GrantPrincipal = {
    kind: policy.audience,
    guestNode: session.guestNode,
  };
  const tx = db.transaction(() => {
    const prepared = prepareIntent(db, policy, principal, intent, opts.clock);
    const txn = intentTxnPrefix(session.guestNode, intent.intentId) + prepared.fingerprint;
    const receipt = readReceipt(db, session.guestNode, intent.intentId);

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

    if (!prepared.targetLive) throw new MhError("auth", "unauthorized");

    if (opts.clock === "submitted")
      return applySubmitted(
        db,
        policy,
        principal,
        intent,
        prepared,
        txn,
        opts.now ?? Date.now(),
      );
    return applyAuthority(db, policy, principal, intent, prepared, txn);
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
      emitReceipt(
        db,
        principal.guestNode,
        intent.intentId,
        makeReceipt(intent.action, prepared, current.id, projection),
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
  mk(
    INTENT_RECEIPT_DATASET,
    receiptRowId(node, intent.intentId),
    RECEIPT_COL,
    receipt,
  );
  ingest(db, changes);

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

function emitReceipt(
  db: DbDriver,
  guestNode: string,
  intentId: string,
  receipt: IntentReceipt,
): void {
  emit(db, INTENT_RECEIPT_DATASET, receiptRowId(guestNode, intentId), RECEIPT_COL, receipt);
}

function readReceipt(
  db: DbDriver,
  guestNode: string,
  intentId: string,
): IntentReceipt | null {
  const row = db
    .query(
      `SELECT value, node_id, txn FROM crdt_changes
       WHERE dataset = ? AND row_id = ? AND col = ?
       ORDER BY hlc DESC LIMIT 1`,
    )
    .get(
      INTENT_RECEIPT_DATASET,
      receiptRowId(guestNode, intentId),
      RECEIPT_COL,
    ) as { value: string | null; node_id: string; txn: string | null } | null;
  if (!row) return null;

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
