import type { DbDriver } from "./driver.ts";
import { randomSuffix } from "./ids.ts";

/** Stable per-machine node id, persisted in the meta table. */
export function getNodeId(db: DbDriver): string {
  const row = db
    .query("SELECT value FROM meta WHERE key = 'node_id'")
    .get() as { value: string } | null;
  if (row) return row.value;
  const id = randomSuffix(8);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return id;
}
