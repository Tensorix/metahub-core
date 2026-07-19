import type { DbDriver } from "./driver.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The blind inbox accepts mail for at most this long without an owner pull. */
export const DROP_ENVELOPE_RETENTION_MS = 30 * DAY_MS;

/** Receipts outlive the inbox by a safety day so a last-moment delivery still
 * has a complete retry/idempotency window on the owner. */
export const INTENT_REPLAY_WINDOW_MS = DROP_ENVELOPE_RETENTION_MS + DAY_MS;

export const INTENT_RECEIPT_DATASET = "intent_receipts";

interface ReceiptChange {
  dataset: string;
  hlc: string;
}

function safeNow(now: number): number {
  return Math.max(0, Math.trunc(Number.isFinite(now) ? now : Date.now()));
}

/** Lexicographic lower bound for every HLC minted at `now - replayWindow`. */
export function intentReceiptCutoffHlc(now = Date.now()): string {
  const cutoff = Math.max(0, safeNow(now) - INTENT_REPLAY_WINDOW_MS);
  return String(cutoff).padStart(15, "0") + "-";
}

export function isExpiredIntentReceipt(
  change: ReceiptChange,
  now = Date.now(),
): boolean {
  return (
    change.dataset === INTENT_RECEIPT_DATASET &&
    change.hlc < intentReceiptCutoffHlc(now)
  );
}

export function filterExpiredIntentReceipts<T extends ReceiptChange>(
  changes: T[],
  now = Date.now(),
): T[] {
  return changes.filter((change) => !isExpiredIntentReceipt(change, now));
}

/** Local protocol GC. Deletion is intentionally not represented as a CRDT
 * tombstone: expired receipts are also filtered at every replication boundary,
 * so an old segment/snapshot cannot resurrect them. */
export function pruneExpiredIntentReceipts(
  db: DbDriver,
  now = Date.now(),
): number {
  return db
    .query(
      "DELETE FROM crdt_changes WHERE dataset = 'intent_receipts' AND hlc < ?",
    )
    .run(intentReceiptCutoffHlc(now)).changes;
}

export function countExpiredIntentReceipts(
  db: DbDriver,
  now = Date.now(),
): number {
  return (
    db
      .query(
        "SELECT COUNT(*) AS n FROM crdt_changes WHERE dataset = 'intent_receipts' AND hlc < ?",
      )
      .get(intentReceiptCutoffHlc(now)) as { n: number }
  ).n;
}

export function intentSubmissionExpired(
  submittedAt: number,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(submittedAt)) return false;
  return Math.trunc(submittedAt) < safeNow(now) - INTENT_REPLAY_WINDOW_MS;
}
