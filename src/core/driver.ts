/**
 * Minimal synchronous SQLite driver surface that every runtime hosting a
 * metahub database must provide. The portable core modules type against this
 * instead of bun:sqlite so the same code can run on Bun (bun:sqlite's
 * `Database` satisfies it structurally — no adapter needed) and in a browser
 * worker (sqlite-wasm behind a small adapter).
 *
 * Keep this surface to what bun:sqlite and sqlite-wasm can both serve
 * synchronously: positional `?` binds, `get`/`all`/`run` on prepared
 * statements, `exec` for scripts, and re-entrant `transaction` wrappers.
 */

export type SqlBindable = string | number | bigint | boolean | null | Uint8Array;

export interface Stmt {
  get(...params: SqlBindable[]): unknown;
  all(...params: SqlBindable[]): unknown[];
  run(...params: SqlBindable[]): { changes: number };
}

export type TxFn<A extends unknown[], R> = ((...args: A) => R) & {
  immediate?: (...args: A) => R;
};

export interface DbDriver {
  query(sql: string): Stmt;
  exec(sql: string): void;
  transaction<A extends unknown[], R>(fn: (...args: A) => R): TxFn<A, R>;
}

export function writeTx<R>(db: DbDriver, fn: () => R): R {
  const tx = db.transaction(fn);
  return (tx.immediate ?? tx)();
}
