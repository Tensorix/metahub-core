// The DbDriver behavioral contract every adapter must satisfy — one shared
// case list, three runners:
//   - bun:sqlite (driver-contract.test.ts, in the normal `bun test` gate) —
//     the reference implementation, and proof the suite itself is sound;
//   - DoSqlDriver on real workerd (test/workerd/do-driver.workerd.ts via
//     @cloudflare/vitest-pool-workers) — NOT in the bun gate, run manually;
//   - (wasm-driver shares the same semantics by construction; a browser runner
//     can adopt this list if it ever grows a harness.)
//
// Each case gets a FRESH database. Cases are synchronous and assertion-library
// agnostic (they throw on failure) so bun:test and vitest both host them.

import type { DbDriver } from "../core/driver.ts";

export interface DriverCase {
  name: string;
  fn: (db: DbDriver) => void;
}

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

export function driverContractCases(): DriverCase[] {
  return [
    {
      name: "get normalizes a miss to null (never undefined)",
      fn(db) {
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
        const row = db.query("SELECT v FROM t WHERE id = ?").get(1);
        if (row !== null) throw new Error(`miss must be null, got ${String(row)}`);
      },
    },
    {
      name: "get/all round-trip text, integer, real and NULL values",
      fn(db) {
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT, n REAL)");
        db.query("INSERT INTO t (id, s, n) VALUES (?, ?, ?)").run(1, "héllo", 1.5);
        db.query("INSERT INTO t (id, s, n) VALUES (?, ?, ?)").run(2, null, 42);
        eq(db.query("SELECT s, n FROM t WHERE id = 1").get(), { s: "héllo", n: 1.5 }, "row 1");
        eq(db.query("SELECT s, n FROM t ORDER BY id").all(), [
          { s: "héllo", n: 1.5 },
          { s: null, n: 42 },
        ], "all rows");
      },
    },
    {
      name: "run reports SQLite changes()",
      fn(db) {
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
        db.query("INSERT INTO t (id, v) VALUES (1, 'a'), (2, 'b'), (3, 'c')").run();
        eq(db.query("UPDATE t SET v = 'x' WHERE id <= 2").run().changes, 2, "update count");
        eq(db.query("DELETE FROM t").run().changes, 3, "delete count");
      },
    },
    {
      name: "INSERT OR IGNORE duplicate reports changes 0 (oplog dedup depends on it)",
      fn(db) {
        db.exec("CREATE TABLE t (a TEXT, b TEXT, UNIQUE (a, b))");
        eq(db.query("INSERT OR IGNORE INTO t (a, b) VALUES (?, ?)").run("x", "y").changes, 1, "first");
        eq(db.query("INSERT OR IGNORE INTO t (a, b) VALUES (?, ?)").run("x", "y").changes, 0, "dup");
      },
    },
    {
      name: "binds normalize: undefined→NULL, boolean→1/0, bigint→number",
      fn(db) {
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, u, b, big)");
        db.query("INSERT INTO t (id, u, b, big) VALUES (?, ?, ?, ?)").run(
          1,
          undefined as unknown as null,
          true,
          7n,
        );
        eq(db.query("SELECT u, b, big FROM t WHERE id = 1").get(), { u: null, b: 1, big: 7 }, "row");
      },
    },
    {
      name: "Uint8Array binds and BLOB reads round-trip as bytes",
      fn(db) {
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, bytes BLOB)");
        const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
        db.query("INSERT INTO t (id, bytes) VALUES (?, ?)").run(1, bytes);
        const row = db.query("SELECT bytes FROM t WHERE id = 1").get() as {
          bytes: Uint8Array | ArrayBuffer;
        };
        const got = row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes);
        eq(Array.from(got), Array.from(bytes), "blob bytes");
      },
    },
    {
      name: "transaction commits on return",
      fn(db) {
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
        db.transaction(() => {
          db.query("INSERT INTO t (id) VALUES (1)").run();
          db.query("INSERT INTO t (id) VALUES (2)").run();
        })();
        eq(db.query("SELECT COUNT(*) AS n FROM t").get(), { n: 2 }, "committed rows");
      },
    },
    {
      name: "transaction rolls back on throw",
      fn(db) {
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
        try {
          db.transaction(() => {
            db.query("INSERT INTO t (id) VALUES (1)").run();
            throw new Error("boom");
          })();
        } catch {
          /* expected */
        }
        eq(db.query("SELECT COUNT(*) AS n FROM t").get(), { n: 0 }, "rolled back");
      },
    },
    {
      name: "nested transactions are savepoints: inner throw caught → outer writes survive",
      fn(db) {
        // The spike ② scenario, and core's real shape (migrate → backfill).
        db.exec("CREATE TABLE t (v TEXT)");
        db.transaction(() => {
          db.query("INSERT INTO t (v) VALUES ('A')").run();
          try {
            db.transaction(() => {
              db.query("INSERT INTO t (v) VALUES ('B')").run();
              throw new Error("inner boom");
            })();
          } catch {
            /* caught by the outer scope */
          }
          db.query("INSERT INTO t (v) VALUES ('C')").run();
        })();
        eq(
          (db.query("SELECT v FROM t ORDER BY v").all() as { v: string }[]).map((r) => r.v),
          ["A", "C"],
          "A and C in, B rolled back",
        );
      },
    },
    {
      name: "nested transaction return value commits both layers",
      fn(db) {
        db.exec("CREATE TABLE t (v TEXT)");
        const out = db.transaction(() => {
          db.query("INSERT INTO t (v) VALUES ('outer')").run();
          return db.transaction(() => {
            db.query("INSERT INTO t (v) VALUES ('inner')").run();
            return 42;
          })();
        })();
        eq(out, 42, "return value");
        eq(db.query("SELECT COUNT(*) AS n FROM t").get(), { n: 2 }, "both rows");
      },
    },
    {
      name: "exec runs multi-statement DDL/DML scripts",
      fn(db) {
        // Non-final statements are never SELECTs (spike ① poisoning rule —
        // a mid-script SELECT leaves its prepared statement un-consumed in
        // workerd and the next run of the same SQL text throws).
        db.exec(`
          CREATE TABLE a (id INTEGER PRIMARY KEY);
          CREATE TABLE b (id INTEGER PRIMARY KEY);
          INSERT INTO a (id) VALUES (1);
          INSERT INTO b (id) VALUES (2);
        `);
        eq(db.query("SELECT COUNT(*) AS n FROM a").get(), { n: 1 }, "table a");
        eq(db.query("SELECT COUNT(*) AS n FROM b").get(), { n: 1 }, "table b");
      },
    },
    {
      name: "repeated execution of one SQL text stays healthy (statement cache)",
      fn(db) {
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
        for (let i = 1; i <= 5; i++) {
          db.query("INSERT INTO t (id, v) VALUES (?, ?)").run(i, `v${i}`);
          eq(db.query("SELECT COUNT(*) AS n FROM t").get(), { n: i }, `round ${i}`);
        }
      },
    },
    {
      name: "PRAGMA table_info works (schema-init column probing)",
      fn(db) {
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
        const cols = (db.query("PRAGMA table_info(t)").all() as { name: string }[]).map(
          (c) => c.name,
        );
        eq(cols.sort(), ["id", "v"], "columns");
      },
    },
  ];
}
