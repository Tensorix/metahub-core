// The DbDriver contract suite against bun:sqlite — the reference run that
// keeps the shared case list itself honest. The DoSqlDriver run of the SAME
// cases lives in test/workerd/ (real workerd via vitest-pool-workers; not part
// of this gate — see the README-style header there).

import { test } from "bun:test";
import { Database } from "bun:sqlite";
import { driverContractCases } from "./driver-contract.ts";

for (const c of driverContractCases()) {
  test(`driver contract (bun:sqlite): ${c.name}`, () => {
    const db = new Database(":memory:");
    try {
      c.fn(db);
    } finally {
      db.close();
    }
  });
}
