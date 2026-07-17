// DoSqlDriver contract on REAL workerd: the same case list the bun:sqlite
// reference run executes (src/room/driver-contract.test.ts), driven against a
// live Durable Object's state.storage. Plus one integration case: the room
// engine's provisioning + a guest write, end to end on the DO driver.
//
// Run manually (not in the bun test gate): cd test/workerd && bun install &&
// bun run test. The `.workerd.ts` suffix (not `.test.ts`) keeps `bun test`
// from picking this file up at the repo root.

// @ts-expect-error cloudflare:test is resolved by vitest-pool-workers at runtime
import { env, runInDurableObject } from "cloudflare:test";
import { it, expect } from "vitest";
import { DoSqlDriver, type DoStorageLike } from "../../src/room/do-driver.ts";
import { driverContractCases } from "../../src/room/driver-contract.ts";
import {
  initRoomDb,
  handleGuestWrite,
  mintRoomGuestSub,
} from "../../src/core/sync/room-protocol.ts";
import { serializeGrantSet } from "../../src/core/grants-core.ts";
import { createDatabase } from "../../src/core/databases.ts";
import { addProperty } from "../../src/core/properties.ts";

interface TestEnv {
  DRIVER: {
    idFromName(name: string): unknown;
    get(id: unknown): unknown;
  };
}

const testEnv = env as TestEnv;

function withFreshDriver(name: string, fn: (db: DoSqlDriver) => void): Promise<unknown> {
  // One DO per case name = one fresh SQLite database per case.
  const stub = testEnv.DRIVER.get(testEnv.DRIVER.idFromName(name));
  return runInDurableObject(stub, (_instance: unknown, state: { storage: DoStorageLike }) => {
    fn(new DoSqlDriver(state.storage));
  });
}

for (const c of driverContractCases()) {
  it(`driver contract (workerd): ${c.name}`, async () => {
    await withFreshDriver(c.name, c.fn);
  });
}

it("room engine on the DO driver: provision + guest write", async () => {
  await withFreshDriver("room-integration", (db) => {
    // initRoomDb runs the full core schema (initSchema) — multi-statement DDL,
    // PRAGMA probes, tx-in-tx migrations — then the room extras.
    const cfg = initRoomDb(db, {
      slug: "itest",
      guestBase: "gitest001",
      grants: "",
    });
    const table = createDatabase(db, { name: "tasks" });
    const prop = addProperty(db, table.id, { name: "title", type: "text" });
    db.query(
      "UPDATE room_config SET value = ? WHERE key = 'config'",
    ).run(
      JSON.stringify({
        ...cfg,
        grants: serializeGrantSet({ v: 1, tables: [{ db: table.id, ops: ["read", "create"] }] }),
      }),
    );
    const cfg2 = { ...cfg, grants: serializeGrantSet({ v: 1, tables: [{ db: table.id, ops: ["read", "create"] }] }) };
    const sub = mintRoomGuestSub(cfg2);
    const rec = handleGuestWrite(db, cfg2, { sub }, {
      op: "createRecord",
      db: "tasks",
      values: { title: "from workerd" },
    });
    expect(rec.cells[prop.id]).toBe("from workerd");
    // The write is attributed to the visitor's sub id, stamped by the room clock.
    const author = db
      .query("SELECT node_id FROM crdt_changes WHERE dataset='records' AND col=? LIMIT 1")
      .get(prop.id) as { node_id: string } | null;
    expect(author?.node_id).toBe(sub);
  });
});
