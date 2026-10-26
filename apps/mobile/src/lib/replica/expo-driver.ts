import type {
  DbDriver,
  SqlBindable,
  Stmt,
  TxFn,
} from "../../../../../src/core/driver.ts";

/** Expo's automatic close sweep also finalizes FTS5's internal statements,
 * which SQLite itself owns and finalizes on close (Android double free).
 * The driver's get/run/all convenience calls finalize every owned statement. */
export const nativeSqliteOpenOptions = {
  finalizeUnusedStatementsBeforeClosing: false,
} as const;

/** Structural Expo SQLite surface keeps the driver testable without loading RN. */
export interface ExpoDatabase {
  execSync(sql: string): void;
  getFirstSync<T>(
    sql: string,
    params: (string | number | null | Uint8Array)[],
  ): T | null;
  getAllSync<T>(
    sql: string,
    params: (string | number | null | Uint8Array)[],
  ): T[];
  runSync(
    sql: string,
    params: (string | number | null | Uint8Array)[],
  ): { changes: number };
  closeSync(): void;
  /** SDK 57 SQLiteDatabase exposes this; optional for older structural adapters. */
  isInTransactionSync?(): boolean;
}
function binds(params: SqlBindable[]): (string | number | null | Uint8Array)[] {
  return params.map((p) => {
    if (typeof p === "boolean") return p ? 1 : 0;
    if (typeof p === "bigint") {
      const value = Number(p);
      if (!Number.isSafeInteger(value))
        throw new RangeError("SQLite bigint exceeds safe integer range");
      return value;
    }
    return p ?? null;
  });
}

/** Keep the SQLite failure (and code) primary while retaining recovery evidence. */
function withTransactionFailure(
  error: unknown,
  rollbackError: unknown,
): unknown {
  if (error instanceof Error) {
    try {
      const cause =
        error.cause === undefined
          ? rollbackError
          : new AggregateError(
              [error.cause, rollbackError],
              "SQLite transaction recovery failures",
            );
      Object.defineProperty(error, "cause", {
        value: cause,
        writable: true,
        configurable: true,
      });
      return error;
    } catch {
      // Frozen/non-extensible errors still retain their code in the wrapper.
    }
  }
  const combined = new AggregateError(
    [error, rollbackError],
    "SQLite transaction and recovery failed",
    { cause: error },
  );
  if (error && typeof error === "object") {
    for (const key of ["code", "errno"] as const) {
      if (key in error)
        Object.defineProperty(combined, key, {
          value: (error as { code?: unknown; errno?: unknown })[key],
        });
    }
  }
  return combined;
}

/** Without a transaction-state probe, conservatively abort on SQLite errors
 * documented to be capable of rolling back the whole transaction. Ordinary
 * constraint/ABORT errors are recoverable and must not poison the outer scope. */
function mayAutoRollback(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; errno?: unknown; message?: unknown };
  if (
    typeof value.code === "string" &&
    /^SQLITE_(FULL|IOERR|NOMEM)(_|$)/.test(value.code)
  )
    return true;
  const messageCode =
    typeof value.message === "string"
      ? /\bError code (\d+)\s*:/i.exec(value.message)?.[1]
      : undefined;
  for (const candidate of [
    value.code,
    value.errno,
    messageCode === undefined ? undefined : Number(messageCode),
  ]) {
    if (typeof candidate === "number" && [7, 10, 13].includes(candidate & 0xff))
      return true;
  }
  return false;
}

/** Every transaction completes synchronously on the single JS database owner. */
export class ExpoDriver implements DbDriver {
  private depth = 0;
  private sequence = 0;
  private poisoned: { error: unknown } | null = null;
  private assertUsable(): void {
    if (this.poisoned) throw this.poisoned.error;
  }
  constructor(readonly sqlite: ExpoDatabase) {}
  private statement<T>(run: () => T): T {
    this.assertUsable();
    try {
      return run();
    } catch (error) {
      let failure = error;
      if (this.depth > 0) {
        let active: boolean;
        try {
          active = this.sqlite.isInTransactionSync
            ? this.sqlite.isInTransactionSync()
            : !mayAutoRollback(error);
        } catch (probeError) {
          failure = withTransactionFailure(error, probeError);
          active = false;
        }
        if (!active) this.poisoned = { error: failure };
      }
      throw failure;
    }
  }
  exec(sql: string): void {
    this.statement(() => this.sqlite.execSync(sql));
  }
  query(sql: string): Stmt {
    return {
      get: (...params) =>
        this.statement(() => this.sqlite.getFirstSync(sql, binds(params))),
      all: (...params) =>
        this.statement(() => this.sqlite.getAllSync(sql, binds(params))),
      run: (...params) =>
        this.statement(() => this.sqlite.runSync(sql, binds(params))),
    };
  }
  transaction<A extends unknown[], R>(fn: (...args: A) => R): TxFn<A, R> {
    const run = (immediate: boolean, args: A): R => {
      const outer = this.depth === 0;
      const name = `mh_native_${++this.sequence}`;
      this.exec(
        outer ? (immediate ? "BEGIN IMMEDIATE" : "BEGIN") : `SAVEPOINT ${name}`,
      );
      this.depth++;
      try {
        const result = fn(...args);
        if (result && typeof (result as { then?: unknown }).then === "function")
          throw new TypeError("Replica transactions must be synchronous");
        this.exec(outer ? "COMMIT" : `RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        let failure = this.poisoned ? this.poisoned.error : error;
        try {
          // Cleanup must bypass the poisoned public SQL gate. SQLite may have
          // already rolled back the whole outer transaction on FULL/IOERR.
          this.sqlite.execSync(
            outer
              ? "ROLLBACK"
              : `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`,
          );
        } catch (rollbackError) {
          failure = withTransactionFailure(failure, rollbackError);
          // A failed savepoint rollback means this outer scope is no longer
          // safe. Block its remaining SQL even if the caller catches the inner
          // exception, so subsequent writes cannot accidentally autocommit.
          this.poisoned = { error: failure };
        }
        throw failure;
      } finally {
        this.depth--;
        if (this.depth === 0) this.poisoned = null;
      }
    };
    const tx: TxFn<A, R> = (...args) => run(false, args);
    tx.immediate = (...args) => run(true, args);
    return tx;
  }
  close(): void {
    this.sqlite.closeSync();
  }
}
