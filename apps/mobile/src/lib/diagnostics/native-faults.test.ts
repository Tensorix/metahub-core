import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverContractCases } from "../../../../../src/room/driver-contract.ts";
import { ExpoDriver, type ExpoDatabase } from "../replica/expo-driver";
import {
  isSqliteFull,
  sqliteErrorEvidence,
  NativeFaultFailure,
  runNativeFaults,
  type NativeFaultRuntime,
} from "./native-faults";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function adapter(sqlite: Database): ExpoDatabase {
  return {
    execSync: (sql) => sqlite.exec(sql),
    getFirstSync: <T>(
      sql: string,
      params: (string | number | null | Uint8Array)[],
    ) => sqlite.query(sql).get(...params) as T | null,
    getAllSync: <T>(
      sql: string,
      params: (string | number | null | Uint8Array)[],
    ) => sqlite.query(sql).all(...params) as T[],
    runSync: (sql, params) => sqlite.query(sql).run(...params),
    closeSync: () => sqlite.close(),
    isInTransactionSync: () => sqlite.inTransaction,
  };
}
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "mh-native-faults-"));
  directories.push(path);
  const opened: string[] = [],
    removed: string[] = [];
  const runtime: NativeFaultRuntime = {
    open(name) {
      expect(name).toMatch(/^native-fault-isolated-[\w-]+\.db$/);
      opened.push(name);
      return adapter(new Database(join(path, name)));
    },
    remove(name) {
      removed.push(name);
      rmSync(join(path, name));
      for (const suffix of ["-wal", "-shm"])
        rmSync(join(path, name + suffix), { force: true });
    },
  };
  return { path, runtime, opened, removed };
}

test("isolated file-backed ExpoDriver exercises real SQLITE_FULL rollback and migration reopen recovery", async () => {
  const f = fixture();
  const steps = await runNativeFaults(f.runtime);
  expect(steps).toHaveLength(2);
  expect(steps[0]).toContain("real SQLITE_FULL (13)");
  expect(steps[0]).toContain("cursor/draft retained after reopen");
  expect(steps[0]).toContain(
    "caught direct/nested FULL blocks outer SQL/commit",
  );
  expect(steps[1]).toContain(
    "one DDL failure surfaced after partial migration",
  );
  expect(steps[1]).toContain("repeat init idempotent");
  expect(f.opened).toHaveLength(4);
  expect(new Set(f.opened).size).toBe(2);
  expect(f.removed).toHaveLength(2);
  expect(readdirSync(f.path)).toEqual([]);
  expect(steps.join(" ")).not.toContain(f.path);
  expect(steps.join(" ")).not.toContain("Retained unsaved text");
});

test("SQLite fullness requires result code 13, never a mocked disk-full message", () => {
  expect(isSqliteFull({ code: "SQLITE_FULL" })).toBe(true);
  expect(isSqliteFull({ errno: 13 })).toBe(true);
  expect(
    isSqliteFull(
      new Error(
        "Call to function rejected: Error code 13: database or disk is full",
      ),
    ),
  ).toBe(true);
  expect(isSqliteFull(new Error("database or disk is full"))).toBe(false);
  expect(isSqliteFull({ code: "SQLITE_IOERR", errno: 10 })).toBe(false);
  expect(isSqliteFull({ message: "Error code 130: private path" })).toBe(false);
});

test("an unenforced page limit fails explicitly and cleans fixtures while still checking migration recovery", async () => {
  const f = fixture();
  const original = f.runtime.open;
  f.runtime.open = (name) => {
    const sqlite = original(name);
    return {
      ...sqlite,
      getFirstSync: <T>(
        sql: string,
        params: (string | number | null | Uint8Array)[],
      ) => {
        if (sql.startsWith("PRAGMA max_page_count="))
          return { max_page_count: 2147483646 } as T;
        return sqlite.getFirstSync<T>(sql, params);
      },
    };
  };
  let failure: unknown;
  try {
    await runNativeFaults(f.runtime);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(NativeFaultFailure);
  const steps = (failure as NativeFaultFailure).steps;
  expect(steps[0]).toStartWith(
    "FAIL native disk-full: max-page-count-not-enforced; evidence=",
  );
  expect(steps[0]).toContain('"actual":2147483646');
  expect(steps[1]).toStartWith("PASS native migration interruption");
  expect(readdirSync(f.path)).toEqual([]);
});

test("fault errors expose only synthetic failure codes and cleanup failures cannot be reported as success", async () => {
  const privateError = new Error(
    "/private/device/user.sqlite authorization=private-secret",
  );
  await expect(
    runNativeFaults({
      open: () => {
        throw privateError;
      },
      remove() {},
    }),
  ).rejects.toThrow("sqlite-operation-failed");
  const f = fixture();
  const remove = f.runtime.remove;
  f.runtime.remove = (name) => {
    remove(name);
    throw privateError;
  };
  try {
    await runNativeFaults(f.runtime);
    throw new Error("cleanup failure was silently passed");
  } catch (error) {
    expect(error).toBeInstanceOf(NativeFaultFailure);
    expect(
      (error as NativeFaultFailure).steps.some((step) =>
        step.endsWith("fixture-cleanup-failed"),
      ),
    ).toBe(true);
    expect(String(error)).not.toContain("private-secret");
    expect(String(error)).not.toContain("user.sqlite");
  }
});

for (const contract of driverContractCases()) {
  test(`production ExpoDriver regression: ${contract.name}`, () => {
    const db = new ExpoDriver(adapter(new Database(":memory:")));
    try {
      contract.fn(db);
    } finally {
      db.close();
    }
  });
}

test("rollback failure preserves the original exception identity and resets driver transaction depth", () => {
  const sqlite = adapter(new Database(":memory:"));
  const driver = new ExpoDriver({
    ...sqlite,
    execSync(sql) {
      sqlite.execSync(sql);
      if (sql === "ROLLBACK") throw new Error("secondary rollback failure");
    },
  });
  const original = new Error("original write failure");
  try {
    driver.exec("CREATE TABLE fixture (n INTEGER)");
    let failure: unknown;
    try {
      driver.transaction(() => {
        driver.exec("INSERT INTO fixture VALUES (1)");
        throw original;
      })();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBe(original);
    expect((failure as Error).cause).toBeInstanceOf(Error);
    expect(((failure as Error).cause as Error).message).toBe(
      "secondary rollback failure",
    );
    expect(driver.query("SELECT count(*) AS n FROM fixture").get()).toEqual({
      n: 0,
    });
    driver.transaction(() => driver.exec("INSERT INTO fixture VALUES (2)"))();
    expect(driver.query("SELECT n FROM fixture").get()).toEqual({ n: 2 });
  } finally {
    driver.close();
  }
});

test("caught nested SQLITE_FULL poisons the remaining outer SQL and commit without persisting any later writes", () => {
  const f = fixture();
  const name = "native-fault-isolated-nested-full.db";
  let db = new ExpoDriver(f.runtime.open(name));
  const blocked: unknown[] = [];
  let full: unknown,
    outerFailure: unknown,
    nestedBodyRan = false;
  try {
    db.exec(
      "CREATE TABLE fixture (n INTEGER); INSERT INTO fixture VALUES (1); CREATE TABLE payload (bytes BLOB); PRAGMA max_page_count=4",
    );
    const cached = db.query("INSERT INTO fixture VALUES (?)");
    try {
      db.transaction(() => {
        db.exec("UPDATE fixture SET n=2");
        try {
          db.transaction(() =>
            db
              .query("INSERT INTO payload VALUES (zeroblob(?))")
              .run(1024 * 1024),
          )();
        } catch (error) {
          full = error;
        }
        const attempts = [
          () => db.exec("INSERT INTO fixture VALUES (3)"),
          () => cached.run(4),
          () => db.query("INSERT INTO fixture VALUES (5) RETURNING n").get(),
          () => db.query("INSERT INTO fixture VALUES (6) RETURNING n").all(),
          () =>
            db.transaction(() => {
              nestedBodyRan = true;
              db.exec("INSERT INTO fixture VALUES (7)");
            })(),
        ];
        for (const attempt of attempts) {
          try {
            attempt();
          } catch (error) {
            blocked.push(error);
          }
        }
        // Return normally: the driver itself must still reject outer commit.
      })();
    } catch (error) {
      outerFailure = error;
    }
    expect(isSqliteFull(full)).toBe(true);
    expect(outerFailure).toBe(full);
    expect(blocked).toHaveLength(5);
    expect(blocked.every((error) => error === full)).toBe(true);
    expect(nestedBodyRan).toBe(false);
    expect((full as Error).cause).toBeInstanceOf(Error);
    db.close();
    db = new ExpoDriver(f.runtime.open(name));
    expect(db.query("SELECT n FROM fixture").all()).toEqual([{ n: 1 }]);
    expect(db.query("SELECT count(*) AS n FROM payload").get()).toEqual({
      n: 0,
    });
    db.exec("PRAGMA max_page_count=2147483646");
    db.transaction(() => db.exec("INSERT INTO fixture VALUES (8)"))();
    db.close();
    db = new ExpoDriver(f.runtime.open(name));
    expect(db.query("SELECT n FROM fixture ORDER BY n").all()).toEqual([
      { n: 1 },
      { n: 8 },
    ]);
  } finally {
    db.close();
    f.runtime.remove(name);
  }
});

test("non-extensible original errors retain their SQLite code and rollback evidence in an aggregate", () => {
  const sqlite = adapter(new Database(":memory:"));
  const secondary = new Error("rollback diagnostic");
  const db = new ExpoDriver({
    ...sqlite,
    execSync(sql) {
      sqlite.execSync(sql);
      if (sql === "ROLLBACK") throw secondary;
    },
  });
  const original = Object.freeze(
    Object.assign(new Error("primary failure"), {
      code: "SQLITE_FULL",
      errno: 13,
    }),
  );
  let failure: unknown;
  try {
    try {
      db.transaction(() => {
        throw original;
      })();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(isSqliteFull(failure)).toBe(true);
    expect((failure as AggregateError).errors).toEqual([original, secondary]);
    expect((failure as AggregateError).cause).toBe(original);
  } finally {
    db.close();
  }
});

for (const method of ["exec", "get", "all", "run"] as const) {
  test(`directly caught ${method} SQLITE_FULL blocks a single transaction's later writes and commit`, () => {
    const f = fixture();
    const name = `native-fault-isolated-direct-${method}.db`;
    let db = new ExpoDriver(f.runtime.open(name));
    let full: unknown, blocked: unknown, outer: unknown;
    try {
      db.exec(
        "CREATE TABLE fixture (n INTEGER); INSERT INTO fixture VALUES (1); CREATE TABLE payload (bytes BLOB); PRAGMA max_page_count=4",
      );
      try {
        db.transaction(() => {
          db.exec("UPDATE fixture SET n=2");
          try {
            if (method === "exec")
              db.exec("INSERT INTO payload VALUES(zeroblob(1048576))");
            else if (method === "run")
              db.query("INSERT INTO payload VALUES(zeroblob(?))").run(1048576);
            else
              db.query("INSERT INTO payload VALUES(zeroblob(?))")[method](
                1048576,
              );
          } catch (error) {
            full = error;
          }
          try {
            db.query("UPDATE fixture SET n=3").run();
          } catch (error) {
            blocked = error;
          }
          // Swallow both exceptions to ensure driver commit also rejects.
        })();
      } catch (error) {
        outer = error;
      }
      expect(isSqliteFull(full)).toBe(true);
      expect(blocked).toBe(full);
      expect(outer).toBe(full);
      db.close();
      db = new ExpoDriver(f.runtime.open(name));
      expect(db.query("SELECT n FROM fixture").all()).toEqual([{ n: 1 }]);
      expect(db.query("SELECT count(*) AS n FROM payload").get()).toEqual({
        n: 0,
      });
      db.exec("PRAGMA max_page_count=2147483646");
      db.transaction(() => db.exec("UPDATE fixture SET n=4"))();
      db.close();
      db = new ExpoDriver(f.runtime.open(name));
      expect(db.query("SELECT n FROM fixture").get()).toEqual({ n: 4 });
    } finally {
      db.close();
      f.runtime.remove(name);
    }
  });
}

test("caught ordinary UNIQUE constraints leave the transaction usable and savepoints recover normally", () => {
  const db = new ExpoDriver(adapter(new Database(":memory:")));
  let constraint: unknown;
  try {
    db.exec("CREATE TABLE fixture (n INTEGER UNIQUE)");
    db.transaction(() => {
      db.query("INSERT INTO fixture VALUES (?)").run(1);
      try {
        db.query("INSERT INTO fixture VALUES (?)").run(1);
      } catch (error) {
        constraint = error;
      }
      db.query("INSERT INTO fixture VALUES (?)").run(2);
      try {
        db.transaction(() => {
          db.exec("INSERT INTO fixture VALUES (3)");
          throw new Error("recoverable inner failure");
        })();
      } catch {
        /* savepoint rollback retains the active outer transaction */
      }
      db.exec("INSERT INTO fixture VALUES (4)");
    })();
    expect(isSqliteFull(constraint)).toBe(false);
    expect(constraint).toBeInstanceOf(Error);
    expect(db.query("SELECT n FROM fixture ORDER BY n").all()).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 4 },
    ]);
  } finally {
    db.close();
  }
});

test("a constraint using ON CONFLICT ROLLBACK poisons the outer scope based on actual SQLite state", () => {
  const db = new ExpoDriver(adapter(new Database(":memory:")));
  let constraint: unknown, blocked: unknown, outer: unknown;
  try {
    db.exec(
      "CREATE TABLE fixture (n INTEGER UNIQUE ON CONFLICT ROLLBACK); INSERT INTO fixture VALUES (1)",
    );
    try {
      db.transaction(() => {
        db.exec("INSERT INTO fixture VALUES (2)");
        try {
          db.exec("INSERT INTO fixture VALUES (1)");
        } catch (error) {
          constraint = error;
        }
        try {
          db.exec("INSERT INTO fixture VALUES (3)");
        } catch (error) {
          blocked = error;
        }
      })();
    } catch (error) {
      outer = error;
    }
    expect(constraint).toBeInstanceOf(Error);
    expect(blocked).toBe(constraint);
    expect(outer).toBe(constraint);
    expect(db.query("SELECT n FROM fixture").all()).toEqual([{ n: 1 }]);
  } finally {
    db.close();
  }
});

test("older adapters without a probe conservatively abort FULL without poisoning normal constraints", () => {
  const sqlite = adapter(new Database(":memory:"));
  delete sqlite.isInTransactionSync;
  const db = new ExpoDriver(sqlite);
  let full: unknown, blocked: unknown;
  try {
    db.exec(
      "CREATE TABLE fixture (n INTEGER UNIQUE); INSERT INTO fixture VALUES (1); CREATE TABLE payload(bytes BLOB); PRAGMA max_page_count=6",
    );
    let outer: unknown;
    try {
      db.transaction(() => {
        try {
          db.query("INSERT INTO payload VALUES(zeroblob(?))").run(1048576);
        } catch (error) {
          full = error;
        }
        try {
          db.exec("INSERT INTO fixture VALUES (2)");
        } catch (error) {
          blocked = error;
        }
      })();
    } catch (error) {
      outer = error;
    }
    expect(isSqliteFull(full)).toBe(true);
    expect(blocked).toBe(full);
    expect(outer).toBe(full);
    db.transaction(() => {
      try {
        db.exec("INSERT INTO fixture VALUES (1)");
      } catch {
        /* normal constraint remains recoverable */
      }
      db.exec("INSERT INTO fixture VALUES (3)");
    })();
    expect(db.query("SELECT n FROM fixture ORDER BY n").all()).toEqual([
      { n: 1 },
      { n: 3 },
    ]);
  } finally {
    db.close();
  }
});

test("RETURNING FULL follows the actual transaction state instead of automatically poisoning a live scope", () => {
  const sqlite = new Database(":memory:");
  const db = new ExpoDriver(adapter(sqlite));
  let activeAtFailure = false,
    full: unknown,
    blocked: unknown,
    outer: unknown;
  try {
    db.exec(
      "CREATE TABLE fixture (n INTEGER); INSERT INTO fixture VALUES (1); CREATE TABLE payload(bytes BLOB); PRAGMA max_page_count=4",
    );
    try {
      db.transaction(() => {
        db.exec("INSERT INTO fixture VALUES (2)");
        try {
          db.query(
            "INSERT INTO payload VALUES(zeroblob(?)) RETURNING rowid",
          ).get(1048576);
        } catch (error) {
          full = error;
          activeAtFailure = sqlite.inTransaction;
        }
        try {
          db.exec("INSERT INTO fixture VALUES (3)");
        } catch (error) {
          blocked = error;
        }
      })();
    } catch (error) {
      outer = error;
    }
    expect(isSqliteFull(full)).toBe(true);
    if (activeAtFailure) {
      expect(blocked).toBeUndefined();
      expect(outer).toBeUndefined();
      expect(db.query("SELECT n FROM fixture ORDER BY n").all()).toEqual([
        { n: 1 },
        { n: 2 },
        { n: 3 },
      ]);
    } else {
      expect(blocked).toBe(full);
      expect(outer).toBe(full);
      expect(db.query("SELECT n FROM fixture").all()).toEqual([{ n: 1 }]);
    }
  } finally {
    db.close();
  }
});

test("Android SDK 57 native char-encoded result 13 is recognized through bounded cause/aggregate chains", () => {
  const native = new Error(
    "Call to NativeStatement.finalizeSync rejected: Error code \r: database or disk is full",
  );
  const wrapped = new Error("Native invocation rejected", {
    cause: new AggregateError([native], "wrapped"),
  });
  expect(isSqliteFull(wrapped)).toBe(true);
  const evidence = sqliteErrorEvidence(wrapped);
  expect(
    evidence.nodes.some((node) => node.messageControlCodes.includes(13)),
  ).toBe(true);
  expect(evidence.nodes.every((node) => !node.messageCodes.includes(13))).toBe(
    true,
  );
  expect(
    isSqliteFull(new Error("Error code \n: database or disk is full")),
  ).toBe(false);
  expect(
    isSqliteFull(new Error("Error code \u0001: database or disk is full")),
  ).toBe(false);
  expect(isSqliteFull(new Error("database or disk is full"))).toBe(false);
  expect(
    isSqliteFull(new Error("Error code 130: database or disk is full")),
  ).toBe(false);
});

test("SQLite fault evidence never exports native exception messages, paths, arbitrary codes, or cyclic causes", () => {
  const native = Object.assign(
    new Error(
      "/private/user.sqlite authorization=private-secret Error code \r: database or disk is full",
    ),
    { code: "private-token", errno: 13 },
  );
  Object.defineProperty(native, "cause", { value: native });
  const evidence = sqliteErrorEvidence(native);
  expect(evidence.nodes).toHaveLength(1);
  expect(evidence.nodes[0]?.numericErrno).toBe(13);
  expect(evidence.nodes[0]?.messageControlCodes).toEqual([13]);
  expect(JSON.stringify(evidence)).not.toContain("private");
  expect(JSON.stringify(evidence)).not.toContain("authorization");
  let chain: Error = new Error("root");
  for (let index = 0; index < 20; index++)
    chain = new Error("wrapper", { cause: chain });
  expect(sqliteErrorEvidence(chain).nodes).toHaveLength(8);
  expect(sqliteErrorEvidence(chain).truncated).toBe(true);
});

test("real SQLite FULL succeeds with Android's source-confirmed error encoding and exports numeric evidence", async () => {
  const f = fixture();
  const open = f.runtime.open;
  let actualFull = 0;
  f.runtime.open = (name) => {
    const sqlite = open(name);
    return {
      ...sqlite,
      runSync(sql, params) {
        try {
          return sqlite.runSync(sql, params);
        } catch (error) {
          if (!isSqliteFull(error)) throw error;
          actualFull++;
          throw new Error(
            "NativeStatement.executeSync rejected: Error code \r: database or disk is full",
          );
        }
      },
    };
  };
  const steps = await runNativeFaults(f.runtime);
  expect(actualFull).toBe(3);
  expect(steps).toHaveLength(2);
  expect(steps[0]).toContain("PASS native disk-full");
  expect(steps[0]).toContain('"messageControlCodes":[13]');
  expect(steps[0]).toContain('"transactionActive":false');
  expect(steps[0]).toContain('"boundary":"native","operation":"payload"');
  expect(steps[0]).not.toContain("NativeStatement.executeSync");
  expect(readdirSync(f.path)).toEqual([]);
});

test("unclassified native failures remain hard failures with redacted shape evidence", async () => {
  const f = fixture();
  const open = f.runtime.open;
  f.runtime.open = (name) => {
    const sqlite = open(name);
    return {
      ...sqlite,
      runSync(sql, params) {
        if (sql.includes("zeroblob"))
          throw new Error(
            "/private/user.sqlite database or disk is full authorization=private-secret",
          );
        return sqlite.runSync(sql, params);
      },
    };
  };
  let failure: unknown;
  try {
    await runNativeFaults(f.runtime);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(NativeFaultFailure);
  const step = (failure as NativeFaultFailure).steps[0]!;
  expect(step).toStartWith(
    "FAIL native disk-full: real-SQLITE_FULL-not-observed; evidence=",
  );
  expect(step).toContain('"hasFullText":true');
  expect(step).toContain('"messageControlCodes":[]');
  expect(step).not.toContain("user.sqlite");
  expect(step).not.toContain("private-secret");
  expect(step).not.toContain("authorization");
  expect((failure as NativeFaultFailure).steps[1]).toStartWith(
    "PASS native migration interruption",
  );
  expect(readdirSync(f.path)).toEqual([]);
});
