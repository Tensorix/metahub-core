/** Isolated synthetic SQLite faults. Never accepts a user database or workspace.
 * The structural runtime allows Bun to exercise the production ExpoDriver with
 * real file-backed SQLite; the default runtime loads Expo SQLite only on demand. */
import type { DbDriver } from "../../../../../src/core/driver.ts";
import { createDraftStore } from "../../../../../src/core/replica/drafts.ts";
import { initSchema } from "../../../../../src/core/schema-init.ts";
import {
  ExpoDriver,
  nativeSqliteOpenOptions,
  type ExpoDatabase,
} from "../replica/expo-driver";

export interface NativeFaultRuntime {
  open(name: string): ExpoDatabase;
  remove(name: string): void;
}
export class NativeFaultFailure extends Error {
  constructor(readonly steps: string[]) {
    super(steps.filter((step) => step.startsWith("FAIL ")).join("; "));
    this.name = "NativeFaultFailure";
  }
}
class FaultAssertion extends Error {}
const assert = (condition: unknown, code: string): void => {
  if (!condition) throw new FaultAssertion(code);
};
/** Expo wraps native exceptions in text; its iOS and Android implementations
 * both include SQLite's numeric result code. Text alone without 13 is rejected. */
export function isSqliteFull(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; errno?: unknown; message?: unknown };
  return (
    value.code === "SQLITE_FULL" ||
    value.code === 13 ||
    value.errno === 13 ||
    (typeof value.message === "string" &&
      /\bError code 13\s*:/i.test(value.message))
  );
}
const peer = "https://native-fault.invalid";
const documentId = "native-fault-document";
const recoveryDraft = {
  title: "Synthetic draft",
  body: "Retained unsaved text",
  revision: 7,
  version: "fixture-version",
};
const readCursor = (db: DbDriver) =>
  db
    .query("SELECT pull_cursor, push_cursor FROM peers WHERE url = ?")
    .get(peer);
const hasColumn = (db: DbDriver, column: string) =>
  (db.query("PRAGMA table_info(peers)").all() as { name: string }[]).some(
    (row) => row.name === column,
  );
function retained(db: DbDriver): void {
  assert(
    JSON.stringify(readCursor(db)) ===
      JSON.stringify({ pull_cursor: 17, push_cursor: 29 }),
    "cursor-changed",
  );
  const draft = createDraftStore(db).readDocument(documentId);
  assert(
    draft?.title === recoveryDraft.title &&
      draft.body === recoveryDraft.body &&
      draft.revision === recoveryDraft.revision &&
      draft.version === recoveryDraft.version,
    "draft-changed",
  );
}
function healthy(db: DbDriver): void {
  const checks = db.query("PRAGMA quick_check").all() as Record<
    string,
    unknown
  >[];
  assert(
    checks.length === 1 &&
      Object.values(checks[0]!).every((value) => value === "ok"),
    "sqlite-integrity-check-failed",
  );
}
function safeFailure(error: unknown): string {
  // Never export native exception messages/stacks, SQL parameters, or paths.
  return error instanceof FaultAssertion
    ? error.message
    : isSqliteFull(error)
      ? "unexpected-SQLITE_FULL"
      : "sqlite-operation-failed";
}
async function nativeRuntime(): Promise<NativeFaultRuntime> {
  const sqlite = await import("expo-sqlite");
  return {
    open: (name) => sqlite.openDatabaseSync(name, nativeSqliteOpenOptions),
    remove: (name) => sqlite.deleteDatabaseSync(name),
  };
}

export async function runNativeFaults(
  runtime?: NativeFaultRuntime,
): Promise<string[]> {
  let environment: NativeFaultRuntime;
  try {
    environment = runtime ?? (await nativeRuntime());
  } catch {
    throw new NativeFaultFailure([
      "FAIL native fault runtime: native-sqlite-unavailable",
    ]);
  }
  const steps: string[] = [];
  const prefix = `native-fault-isolated-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (const kind of ["disk-full", "migration-interruption"] as const) {
    const name = `${prefix}-${kind}.db`;
    let db: ExpoDriver | undefined;
    let created = false;
    try {
      let actualFull = false;
      const open = (observeFull = false) => {
        const sqlite = environment.open(name);
        created = true;
        if (!observeFull) return new ExpoDriver(sqlite);
        const observed: ExpoDatabase = {
          execSync: (sql) => sqlite.execSync(sql),
          getFirstSync: (sql, params) => sqlite.getFirstSync(sql, params),
          getAllSync: (sql, params) => sqlite.getAllSync(sql, params),
          runSync: (sql, params) => {
            try {
              return sqlite.runSync(sql, params);
            } catch (error) {
              if (isSqliteFull(error)) actualFull = true;
              throw error;
            }
          },
          closeSync: () => sqlite.closeSync(),
          isInTransactionSync: sqlite.isInTransactionSync?.bind(sqlite),
        };
        return new ExpoDriver(observed);
      };
      db = open(kind === "disk-full");
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      if (kind === "disk-full") {
        initSchema(db);
        const drafts = createDraftStore(db);
        drafts.checkpointDocument(documentId, recoveryDraft);
        db.query(
          "INSERT INTO peers (url, pull_cursor, push_cursor) VALUES (?, 17, 29)",
        ).run(peer);
        db.exec(
          "CREATE TABLE native_fault_payload (id INTEGER PRIMARY KEY, bytes BLOB)",
        );
        const pages = (
          db.query("PRAGMA page_count").get() as { page_count: number }
        ).page_count;
        const pageSize = (
          db.query("PRAGMA page_size").get() as { page_size: number }
        ).page_size;
        const cap = pages + 2;
        const limit = db.query(`PRAGMA max_page_count=${cap}`).get() as {
          max_page_count: number;
        };
        assert(limit.max_page_count === cap, "max-page-count-not-enforced");
        const payloadBytes = (cap + 8) * pageSize;
        assert(
          payloadBytes > 0 && payloadBytes < 16 * 1024 * 1024,
          "fixture-size-out-of-bounds",
        );
        let failed = false,
          surfacedFull = false;
        try {
          db.transaction(() => {
            db!
              .query(
                "UPDATE peers SET pull_cursor=18, push_cursor=30 WHERE url=?",
              )
              .run(peer);
            drafts.acknowledgeDocument(documentId, recoveryDraft.revision);
            db!
              .query(
                "INSERT INTO native_fault_payload(bytes) VALUES (zeroblob(?))",
              )
              .run(payloadBytes);
          })();
        } catch (error) {
          failed = true;
          surfacedFull = isSqliteFull(error);
        }
        assert(failed && actualFull, "real-SQLITE_FULL-not-observed");
        assert(surfacedFull, "driver-replaced-SQLITE_FULL");
        retained(db);
        assert(
          (
            db
              .query("SELECT count(*) AS n FROM native_fault_payload")
              .get() as { n: number }
          ).n === 0,
          "failed-blob-was-committed",
        );
        // SQLITE_FULL may abort every savepoint. Catching it inside an outer
        // callback must not permit a later write to run in SQLite autocommit.
        actualFull = false;
        let nestedFailure: unknown, outerFailure: unknown;
        const blocked: unknown[] = [];
        try {
          db.transaction(() => {
            db!.query("UPDATE peers SET pull_cursor=18 WHERE url=?").run(peer);
            try {
              db!.transaction(() => {
                drafts.acknowledgeDocument(documentId, recoveryDraft.revision);
                db!
                  .query(
                    "INSERT INTO native_fault_payload(bytes) VALUES (zeroblob(?))",
                  )
                  .run(payloadBytes);
              })();
            } catch (error) {
              nestedFailure = error;
            }
            for (const write of [
              () =>
                db!
                  .query("UPDATE peers SET push_cursor=30 WHERE url=?")
                  .run(peer),
              () => db!.exec("DELETE FROM replica_document_drafts"),
            ]) {
              try {
                write();
              } catch (error) {
                blocked.push(error);
              }
            }
          })();
        } catch (error) {
          outerFailure = error;
        }
        assert(
          actualFull && isSqliteFull(nestedFailure),
          "nested-real-SQLITE_FULL-not-observed",
        );
        assert(
          outerFailure === nestedFailure &&
            blocked.length === 2 &&
            blocked.every((error) => error === nestedFailure),
          "nested-full-allowed-outer-SQL-or-commit",
        );
        retained(db);
        actualFull = false;
        let statementFailure: unknown,
          directOuterFailure: unknown,
          blockedDirect: unknown;
        try {
          db.transaction(() => {
            db!.query("UPDATE peers SET pull_cursor=18 WHERE url=?").run(peer);
            try {
              db!
                .query(
                  "INSERT INTO native_fault_payload(bytes) VALUES (zeroblob(?))",
                )
                .run(payloadBytes);
            } catch (error) {
              statementFailure = error;
            }
            try {
              db!
                .query("UPDATE peers SET push_cursor=30 WHERE url=?")
                .run(peer);
            } catch (error) {
              blockedDirect = error;
            }
          })();
        } catch (error) {
          directOuterFailure = error;
        }
        assert(
          actualFull && isSqliteFull(statementFailure),
          "direct-real-SQLITE_FULL-not-observed",
        );
        assert(
          blockedDirect === statementFailure &&
            directOuterFailure === statementFailure,
          "caught-direct-full-allowed-SQL-or-commit",
        );
        retained(db);
        // A successful follow-up transaction proves driver depth and SQLite's
        // transaction state recovered after its automatic full-disk rollback.
        db.exec("PRAGMA max_page_count=2147483646");
        db.transaction(() =>
          db!
            .query("INSERT INTO native_fault_payload(bytes) VALUES (?)")
            .run(new Uint8Array([1, 2, 3])),
        )();
        db.close();
        db = undefined;
        db = open();
        initSchema(db);
        retained(db);
        assert(
          (
            db
              .query("SELECT count(*) AS n FROM native_fault_payload")
              .get() as { n: number }
          ).n === 1,
          "post-fault-write-not-durable",
        );
        healthy(db);
        steps.push(
          `PASS native disk-full: real SQLITE_FULL (13), max_page_count=${cap}, transaction rolled back, caught direct/nested FULL blocks outer SQL/commit, cursor/draft retained after reopen, later write durable`,
        );
      } else {
        // Deliberately legacy schema: the first peer-column migration commits,
        // then exactly one later DDL is interrupted before SQLite executes it.
        db.exec(
          "CREATE TABLE peers (url TEXT PRIMARY KEY, pull_cursor INTEGER, push_cursor INTEGER)",
        );
        db.query(
          "INSERT INTO peers (url, pull_cursor, push_cursor) VALUES (?, 17, 29)",
        ).run(peer);
        createDraftStore(db).checkpointDocument(documentId, recoveryDraft);
        const interruption = new Error("synthetic-one-shot-DDL-interruption");
        let injected = 0,
          observed = false;
        const driver = db;
        const wrapped: DbDriver = {
          query: (sql) => driver.query(sql),
          transaction: (fn) => driver.transaction(fn),
          exec(sql) {
            if (
              !injected &&
              /^ALTER TABLE peers ADD COLUMN label\b/i.test(sql.trim())
            ) {
              injected++;
              throw interruption;
            }
            driver.exec(sql);
          },
        };
        try {
          initSchema(wrapped);
        } catch (error) {
          observed = error === interruption;
        }
        assert(observed && injected === 1, "one-shot-DDL-failure-not-surfaced");
        assert(
          hasColumn(db, "token") && !hasColumn(db, "label"),
          "partial-migration-not-observed",
        );
        retained(db);
        db.close();
        db = undefined;
        db = open();
        initSchema(db);
        for (const column of ["token", "label", "enabled", "kind", "config"])
          assert(hasColumn(db, column), "migration-column-not-recovered");
        retained(db);
        initSchema(db);
        retained(db);
        healthy(db);
        steps.push(
          "PASS native migration interruption: one DDL failure surfaced after partial migration, close/reopen initSchema recovered, cursor/draft retained, repeat init idempotent",
        );
      }
    } catch (error) {
      steps.push(`FAIL native ${kind}: ${safeFailure(error)}`);
    } finally {
      try {
        db?.close();
      } catch {
        steps.push(`FAIL native ${kind}: fixture-close-failed`);
      }
      if (created) {
        try {
          environment.remove(name);
        } catch {
          steps.push(`FAIL native ${kind}: fixture-cleanup-failed`);
        }
      }
    }
  }
  if (steps.some((step) => step.startsWith("FAIL ")))
    throw new NativeFaultFailure(steps);
  return steps;
}
