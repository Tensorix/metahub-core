// DbDriver adapter over sqlite-wasm's OO1 API (see src/core/driver.ts). Runs
// inside the dedicated DB worker on an opfs-sahpool database, giving the
// portable core modules the same synchronous surface bun:sqlite provides.

import type { DbDriver, Stmt, SqlBindable } from "../../core/driver.ts";

/** The slice of sqlite-wasm's oo1.DB this adapter consumes. */
export interface Oo1Db {
  exec(opts: { sql: string; bind?: unknown[] }): unknown;
  selectObject(sql: string, bind?: unknown[]): Record<string, unknown> | undefined;
  selectObjects(sql: string, bind?: unknown[]): Record<string, unknown>[];
  changes(): number;
}

export class WasmDriver implements DbDriver {
  private txDepth = 0;

  constructor(private readonly db: Oo1Db) {}

  query(sql: string): Stmt {
    const db = this.db;
    return {
      get(...params: SqlBindable[]): unknown {
        return db.selectObject(sql, normalize(params)) ?? null;
      },
      all(...params: SqlBindable[]): unknown[] {
        return db.selectObjects(sql, normalize(params));
      },
      run(...params: SqlBindable[]): { changes: number } {
        db.exec({ sql, bind: normalize(params) });
        return { changes: db.changes() };
      },
    };
  }

  exec(sql: string): void {
    this.db.exec({ sql });
  }

  // Savepoint-nested like bun:sqlite's transaction(), so a tx-wrapped core
  // function calling another tx-wrapped one (e.g. migrate → backfill) works.
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const name = `mh_tx_${this.txDepth}`;
      this.exec(this.txDepth === 0 ? "BEGIN" : `SAVEPOINT ${name}`);
      this.txDepth++;
      try {
        const out = fn(...args);
        this.txDepth--;
        this.exec(this.txDepth === 0 ? "COMMIT" : `RELEASE ${name}`);
        return out;
      } catch (e) {
        this.txDepth--;
        this.exec(this.txDepth === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw e;
      }
    };
  }
}

/** sqlite-wasm binds true/false as 1/0 itself, but normalize undefined→null and
 *  return a plain array (oo1 treats [] as "no binds"). */
function normalize(params: SqlBindable[]): unknown[] | undefined {
  if (params.length === 0) return undefined;
  return params.map((p) => (p === undefined ? null : p));
}
