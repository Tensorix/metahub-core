// Test helper (not a test file): the edge worker's EdgeSql surface over an
// in-memory bun:sqlite database — the same SQLite dialect D1 speaks, so the
// worker handler logic runs verbatim under `bun test`. Lives outside
// edge-worker.ts because the worker itself must stay zero-dependency.

import { Database } from "bun:sqlite";
import { EDGE_SCHEMA_SQL, type EdgeSql } from "./edge-worker.ts";

export function memSql(): EdgeSql {
  const d = new Database(":memory:");
  d.exec(EDGE_SCHEMA_SQL);
  return {
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return d.query(sql).all(...(params as never[])) as T[];
    },
    async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
      return { changes: d.query(sql).run(...(params as never[])).changes };
    },
  };
}
