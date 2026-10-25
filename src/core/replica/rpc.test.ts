import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WasmDriver } from "../../webui/data/wasm-driver.ts";
import { mapApiRequest } from "../../webui/data/api-map.ts";
import { initSchema } from "../schema-init.ts";
import { createReplicaService } from "./service.ts";
import { replicaRpcOps } from "./rpc.ts";

/** Exercise the actual browser OO1 driver + portable worker op map through its
 * HTTP-parity API mapping, without browser globals or OPFS in the test runner. */
function browser() {
  const sqlite = new Database(":memory:");
  const driver = new WasmDriver({
    exec({ sql, bind }) { if (bind?.length) return sqlite.query(sql).run(...bind as any[]); sqlite.exec(sql); },
    selectObject: (sql, bind) => sqlite.query(sql).get(...(bind ?? []) as any[]) as Record<string, unknown> | undefined,
    selectObjects: (sql, bind) => sqlite.query(sql).all(...(bind ?? []) as any[]) as Record<string, unknown>[],
    changes: () => (sqlite.query("SELECT changes() AS n").get() as { n: number }).n,
  });
  initSchema(driver);
  const service = createReplicaService(driver);
  const ops = replicaRpcOps(() => service);
  const request = (method: string, path: string, query: Record<string, string> = {}, body: any = null): any => {
    const rpc = mapApiRequest(method, path, new URLSearchParams(query), body);
    if (!rpc || !ops[rpc.op]) throw Error(`unmapped ${method} ${path}`);
    return ops[rpc.op]!(...rpc.args);
  };
  return { sqlite, driver, service, ops, request };
}

test("browser shared RPC keeps document create/get/update versions, conflicts and undo history", () => {
  const { sqlite, service, ops, request } = browser();
  try {
    const created = ops.createDocument!({ title: "Browser draft", body: "Original" }) as any;
    expect(created.version).toBeUndefined();
    const fetched = ops.getDocument!(created.id) as any;
    expect(typeof fetched.version).toBe("string");
    const changed = ops.updateDocument!(created.id, { body: "Updated" }, fetched.version) as any;
    expect(changed.version).not.toBe(fetched.version);
    expect(() => ops.updateDocument!(created.id, { body: "Stale" }, fetched.version)).toThrow();
    expect((ops.getDocument!(created.id) as any).body).toBe("Updated");
    const history = ops.listDocumentRevisions!(created.id) as any[];
    expect(history.length).toBeGreaterThan(1);
    const prior = history.find(row => row.version === fetched.version) ?? history[history.length - 1];
    expect(prior).toBeDefined();
    ops.revertDocument!(created.id, prior.version, changed.version);
    expect((ops.getDocument!(created.id) as any).body).toBe("Original");
    const duplicated = ops.duplicateDocument!(created.id, { title: "Copy" }) as any;
    expect(typeof duplicated.version).toBe("string");
    expect(ops.deleteDocument!(duplicated.id)).toEqual({ ok: true });
    expect(() => ops.getDocument!(duplicated.id)).toThrow("no such document");
    expect(() => service.dispatchRpc("constructor", [])).toThrow("unknown replica command");
  } finally { service.dispose(); sqlite.close(); }
});

test("browser shared RPC preserves database/property/record API mapping and invalid-write rollback", () => {
  const { sqlite, driver, service, ops, request } = browser();
  try {
    const database = request("POST", "/api/databases", {}, { name: "Browser table" });
    const property = request("POST", "/api/properties", {}, { db: database.id, name: "Score", type: "number" });
    const record = request("POST", "/api/records", { db: database.id }, { Score: 42 });
    expect(request("GET", "/api/record", { id: record.id }).values.Score).toBe(42);
    request("PATCH", "/api/record", { id: record.id }, { Score: 7 });
    const before = driver.query("SELECT max(seq) AS n FROM crdt_changes").get();
    expect(() => request("PATCH", "/api/record", { id: record.id }, { Score: "invalid" })).toThrow();
    expect(driver.query("SELECT max(seq) AS n FROM crdt_changes").get()).toEqual(before);
    expect(request("GET", "/api/records", { db: database.id })[0].values.Score).toBe(7);
    expect(request("DELETE", "/api/record", { id: record.id })).toEqual({ ok: true });
    expect(ops.removeProperty!(property.id)).toEqual({ ok: true });
    expect(request("DELETE", "/api/database", { id: database.id })).toEqual({ ok: true });
    expect(request("GET", "/api/databases")).toEqual([]);
  } finally { service.dispose(); sqlite.close(); }
});
