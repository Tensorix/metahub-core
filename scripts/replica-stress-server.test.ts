import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createReplicaStressServer, STRESS_FIXTURE, STRESS_TOKEN } from "./replica-stress-server.ts";
import { initSchema } from "../src/core/schema-init.ts";
import { emit } from "../src/core/crdt.ts";
import { syncWithPeer } from "../src/core/sync/client.ts";

test("native stress fixture marks its isolation and applies real HTTP fault controls per node", async () => {
  const server = createReplicaStressServer();
  const db = new Database(":memory:"); initSchema(db);
  db.query("INSERT INTO meta(key,value) VALUES ('node_id','native-fixture-test')").run();
  const node = "native-fixture-test";
  const headers = { authorization: `Bearer ${STRESS_TOKEN}`, "content-type": "application/json" };
  const control = (mode: string) => fetch(server.url + "/fixture/fault", { method: "POST", headers, body: JSON.stringify({ node, mode }) });
  const stats = async () => (await fetch(server.url + `/fixture/stats?node=${node}`, { headers })).json();
  const sync = (signal?: AbortSignal) => syncWithPeer(db, server.url, { token: STRESS_TOKEN, pushLimit: 25, pullLimit: 25, signal });
  try {
    expect((await fetch(server.url + "/fixture")).status).toBe(401);
    expect(await (await fetch(server.url + "/fixture", { headers })).json()).toEqual({ fixture: STRESS_FIXTURE, isolated: true });
    emit(db, "databases", "db_fixture", "name", "Queued");
    await control("offline"); await expect(sync()).rejects.toThrow("503");
    expect(db.query("SELECT * FROM peers").all()).toEqual([]);
    await control("lost-response"); await expect(sync()).rejects.toThrow("503");
    expect(db.query("SELECT * FROM peers").all()).toEqual([]);
    expect((await stats()).uniqueUploadedOps).toBe(1);
    await control("none"); await sync();
    expect((await stats()).uniqueUploadedOps).toBe(1);
    emit(db, "databases", "db_fixture", "name", "Pending interruption");
    const before = db.query("SELECT pull_cursor,push_cursor FROM peers").get();
    await control("held-response");
    const controller = new AbortController();
    const pending = sync(controller.signal).then(() => false, () => true);
    let waiting = false;
    for (let i = 0; i < 100; i++) { if ((await stats()).waiting) { waiting = true; break; } await Bun.sleep(1); }
    expect(waiting).toBe(true);
    controller.abort(new Error("fixture interrupted"));
    expect(await pending).toBe(true);
    expect(db.query("SELECT pull_cursor,push_cursor FROM peers").get()).toEqual(before);
    await control("none"); await sync();
    await control("bad-json"); await expect(sync()).rejects.toThrow();
    await control("unauthorized"); await expect(sync()).rejects.toMatchObject({ code: "auth" });
  } finally { await control("none"); await server.stop(); db.close(); }
}, 10_000);

test("Release diagnostics export only tagged synthetic reports through the authenticated loopback fixture", async () => {
  const server = createReplicaStressServer();
  const headers = { authorization: `Bearer ${STRESS_TOKEN}`, "content-type": "application/json" };
  const send = (body: unknown) => fetch(server.url + "/fixture/reports", { method: "POST", headers, body: JSON.stringify(body) });
  try {
    expect((await fetch(server.url + "/fixture/reports")).status).toBe(401);
    expect((await send({ kind: "network", report: { environment: { platform: "android", artifactClass: "normal-application" } } })).status).toBe(400);
    const report = { environment: { platform: "android", artifactClass: "synthetic-native-diagnostics" }, status: "COMPLETE" };
    expect((await send({ kind: "network", report })).status).toBe(200);
    expect(await (await fetch(server.url + "/fixture/reports", { headers })).json()).toEqual({ "android-network": report });
  } finally { await server.stop(); }
});
