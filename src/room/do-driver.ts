// DbDriver adapter over a Durable Object's `ctx.storage.sql` (SqlStorage) —
// the workerd counterpart of src/webui/data/wasm-driver.ts, written against
// the same contract line by line:
//   - `get` normalizes a miss to null (never undefined);
//   - `run` reports SQLite's changes() count;
//   - binds normalize undefined→null, boolean→1/0, and Uint8Array→ArrayBuffer
//     (workerd's SQL bindings take ArrayBuffer, not typed arrays); bigint is
//     converted to number (nothing in core binds beyond 2^53);
//   - BLOB column values come back as ArrayBuffer and are normalized to
//     Uint8Array so portable core code sees one shape everywhere.
//
// transaction() maps DIRECTLY and recursively onto storage.transactionSync —
// no depth guard: spike ② proved transactionSync nests with true savepoint
// granularity (inner throw caught by the outer keeps the outer's writes), which
// is exactly bun:sqlite's / wasm-driver's nested-transaction semantics. The
// wasm-driver's BEGIN/SAVEPOINT SQL approach must NOT be ported here — workerd
// rejects explicit transaction SQL outright.
//
// exec() may carry multi-statement scripts (spike ①), with two hard rules the
// callers must honor:
//   1. only the LAST statement of a multi-statement exec may have parameters
//      (we never pass any — exec is parameterless by the DbDriver contract);
//   2. NEVER place a SELECT in a non-final position: workerd leaves the
//      mid-script SELECT's prepared statement un-consumed and the next
//      execution of the same SQL text throws "can only be executed once at a
//      time". SELECTs always go through query() as single statements.

import type { DbDriver, Stmt, SqlBindable } from "../core/driver.ts";

/** The cursor slice this adapter consumes (workerd SqlStorageCursor). */
export interface SqlCursorLike {
  toArray(): Record<string, unknown>[];
  /** Billing-metric row counter — fallback only, see changes() below. */
  rowsWritten: number;
}

/** The slice of DurableObjectStorage this adapter consumes. */
export interface DoStorageLike {
  sql: { exec(query: string, ...bindings: unknown[]): SqlCursorLike };
  transactionSync<T>(closure: () => T): T;
}

export class DoSqlDriver implements DbDriver {
  /** Whether `SELECT changes()` is authorized in this runtime (probed once).
   *  null = unknown, true/false = probe result. */
  private changesFnOk: boolean | null = null;

  constructor(private readonly storage: DoStorageLike) {}

  query(sql: string): Stmt {
    const self = this;
    return {
      get(...params: SqlBindable[]): unknown {
        const rows = self.storage.sql.exec(sql, ...normalizeBinds(params)).toArray();
        return rows.length > 0 ? normalizeRow(rows[0]!) : null;
      },
      all(...params: SqlBindable[]): unknown[] {
        return self.storage.sql.exec(sql, ...normalizeBinds(params)).toArray().map(normalizeRow);
      },
      run(...params: SqlBindable[]): { changes: number } {
        const cur = self.storage.sql.exec(sql, ...normalizeBinds(params));
        cur.toArray(); // always consume — an unconsumed cursor poisons the statement cache
        return { changes: self.changes(cur) };
      },
    };
  }

  exec(sql: string): void {
    // Consume the (last statement's) cursor for the same poisoning reason.
    this.storage.sql.exec(sql).toArray();
  }

  // Direct recursive mapping — transactionSync nests as true savepoints
  // (spike ②), matching bun:sqlite's transaction() for core's tx-in-tx callers
  // (e.g. migrate → backfill).
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => this.storage.transactionSync(() => fn(...args));
  }

  /** SQLite's changes() when available; otherwise the cursor's rowsWritten.
   *  rowsWritten is a metering counter that may include index writes, so it is
   *  only guaranteed to agree with changes() on the zero/nonzero boundary —
   *  which is all the room-side core paths test (`.changes > 0`). */
  private changes(cur: SqlCursorLike): number {
    if (this.changesFnOk !== false) {
      try {
        const rows = this.storage.sql.exec("SELECT changes() AS c").toArray();
        this.changesFnOk = true;
        return Number(rows[0]?.c ?? 0);
      } catch {
        this.changesFnOk = false;
      }
    }
    return cur.rowsWritten;
  }
}

function normalizeBinds(params: SqlBindable[]): unknown[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    if (typeof p === "bigint") return Number(p);
    if (p instanceof Uint8Array) {
      // Fresh ArrayBuffer (never a shared-buffer view slice).
      const buf = new ArrayBuffer(p.byteLength);
      new Uint8Array(buf).set(p);
      return buf;
    }
    return p;
  });
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v instanceof ArrayBuffer) row[k] = new Uint8Array(v);
  }
  return row;
}
