import type { DbDriver } from "../driver.ts";
import type { Change } from "../crdt.ts";
import { MhError } from "../errors.ts";

export const historyChangeKey = (c: Change) => JSON.stringify([c.dataset, c.row_id, c.col, c.hlc]);
export function observeHistory(db: DbDriver, changes: readonly Change[], at: number): void {
  if (!Number.isSafeInteger(at) || at < 0) throw new MhError("clock_skew", "invalid history observation time");
  db.exec(`CREATE TABLE IF NOT EXISTS sync_history_observations (
    dataset TEXT NOT NULL,row_id TEXT NOT NULL,col TEXT NOT NULL,hlc TEXT NOT NULL,at INTEGER NOT NULL,
    PRIMARY KEY(dataset,row_id,col,hlc))`);
  const insert = db.query(`INSERT INTO sync_history_observations(dataset,row_id,col,hlc,at) VALUES(?,?,?,?,?)
    ON CONFLICT(dataset,row_id,col,hlc) DO UPDATE SET at=MIN(at,excluded.at)`);
  for (const c of changes) insert.run(c.dataset,c.row_id,c.col,c.hlc,at);
}
