import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../../core/schema-init";
import { createReplicaService } from "../../core/replica/service";
import { replicaRpcOps } from "../../core/replica/rpc";
import { webuiRoutes } from "./routes";
import type { RouteCtx } from "../../core/sync/routes";

test("HTTP, worker RPC and native query adapters agree on cursor and progressive pages", async () => {
  const db = new Database(":memory:");
  initSchema(db);
  const service = createReplicaService(db),
    worker = replicaRpcOps(() => service);
  const database = service.commands.createDatabase({ name: "Parity" }),
    number = service.commands.addProperty(database.id, {
      name: "Number",
      type: "number",
    });
  const insert = db.query(
    "INSERT INTO records(id,database_id,order_key,data) VALUES(?,?,?,?)",
  );
  for (let i = 0; i < 240; i++)
    insert.run(
      "r" + String(i).padStart(4, "0"),
      database.id,
      String(i).padStart(4, "0"),
      JSON.stringify({ [number.id]: i % 17 }),
    );
  const http = async (
    method: string,
    path: string,
    query: Record<string, string>,
    body?: unknown,
  ) => {
    const route = webuiRoutes.find(
      (r) => r.path === path && r.method === method,
    )!;
    const response = (await route.handler(
      new Request("http://local" + path + "?" + new URLSearchParams(query), {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      }),
      { db, node: "test" } as RouteCtx,
    )) as Response;
    expect(response.ok).toBe(true);
    return response.json() as Promise<any>;
  };
  try {
    for (const query of [
      { protocol: 2 },
      {
        protocol: 2,
        filter: {
          op: "and",
          rules: [{ id: "n", prop: number.id, cond: "ge", value: 5 }],
        },
      },
      { protocol: 2, sort: [{ prop: number.id, desc: true }] },
    ]) {
      const native = await service.client.openRecordQuery(
        database.id,
        query as any,
      );
      const rpc = (await worker.openRecordQuery!(database.id, query)) as any;
      const remote = await http(
        "POST",
        "/api/record-query",
        { db: database.id },
        query,
      );
      for (const [status, id] of [
        [() => service.client.recordQueryStatus(native.id), native.id],
        [() => worker.recordQueryStatus!(rpc.id), rpc.id],
        [
          () => http("GET", "/api/record-query/status", { id: remote.id }),
          remote.id,
        ],
      ] as const) {
        let state = (await status()) as any;
        while (state.statistics === "loading") {
          await Bun.sleep(1);
          state = await status();
        }
        expect(state.total).toBe(query.filter ? 168 : 240);
      }
      const a = await service.client.readRecordQuery(native.id, 100, 100),
        b = await worker.readRecordQuery!(rpc.id, 100, 100),
        c = await http(
          "POST",
          "/api/record-query/page",
          { id: remote.id },
          { offset: 100, limit: 100 },
        );
      expect(b).toEqual(a);
      expect(c).toEqual(a);
      await service.client.closeRecordQuery(native.id);
      await worker.closeRecordQuery!(rpc.id);
      await http("DELETE", "/api/record-query", { id: remote.id });
    }
  } finally {
    service.dispose();
    db.close();
  }
});
