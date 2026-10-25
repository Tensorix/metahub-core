import type { DbDriver, SqlBindable, Stmt, TxFn } from "../../../../../src/core/driver.ts";

/** Expo's automatic close sweep also finalizes FTS5's internal statements,
 * which SQLite itself owns and finalizes on close (Android double free).
 * The driver's get/run/all convenience calls finalize every owned statement. */
export const nativeSqliteOpenOptions = {
  finalizeUnusedStatementsBeforeClosing: false,
} as const;

/** Structural Expo SQLite surface keeps the driver testable without loading RN. */
export interface ExpoDatabase {
  execSync(sql: string): void;
  getFirstSync<T>(sql: string, params: (string | number | null | Uint8Array)[]): T | null;
  getAllSync<T>(sql: string, params: (string | number | null | Uint8Array)[]): T[];
  runSync(sql: string, params: (string | number | null | Uint8Array)[]): { changes: number };
  closeSync(): void;
}
function binds(params: SqlBindable[]): (string | number | null | Uint8Array)[] {
  return params.map(p => {
    if (typeof p === "boolean") return p ? 1 : 0;
    if (typeof p === "bigint") {
      const value = Number(p);
      if (!Number.isSafeInteger(value)) throw new RangeError("SQLite bigint exceeds safe integer range");
      return value;
    }
    return p ?? null;
  });
}

/** Every transaction completes synchronously on the single JS database owner. */
export class ExpoDriver implements DbDriver {
  private depth = 0;
  private sequence = 0;
  constructor(readonly sqlite: ExpoDatabase) {}
  exec(sql: string): void { this.sqlite.execSync(sql); }
  query(sql: string): Stmt {
    return {
      get: (...params) => this.sqlite.getFirstSync(sql, binds(params)),
      all: (...params) => this.sqlite.getAllSync(sql, binds(params)),
      run: (...params) => this.sqlite.runSync(sql, binds(params)),
    };
  }
  transaction<A extends unknown[], R>(fn: (...args: A) => R): TxFn<A, R> {
    const run = (immediate: boolean, args: A): R => {
      const outer = this.depth === 0;
      const name = `mh_native_${++this.sequence}`;
      this.exec(outer ? (immediate ? "BEGIN IMMEDIATE" : "BEGIN") : `SAVEPOINT ${name}`);
      this.depth++;
      try {
        const result = fn(...args);
        if (result && typeof (result as { then?: unknown }).then === "function")
          throw new TypeError("Replica transactions must be synchronous");
        this.exec(outer ? "COMMIT" : `RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        this.exec(outer ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);
        throw error;
      } finally { this.depth--; }
    };
    const tx: TxFn<A, R> = (...args) => run(false, args);
    tx.immediate = (...args) => run(true, args);
    return tx;
  }
  close(): void { this.sqlite.closeSync(); }
}
