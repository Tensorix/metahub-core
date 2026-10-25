import { openDatabaseSync } from "expo-sqlite";
import { ExpoDriver, nativeSqliteOpenOptions } from "../replica/expo-driver";
import { initSchema } from "../../../../../src/core/schema-init.ts";
import { createReplicaService } from "../../../../../src/core/replica/service.ts";
import { syncWithPeer } from "../../../../../src/core/sync/client.ts";
import { getNodeId } from "../../../../../src/core/node.ts";
import { PairResponseSchema, PAIR_PATH } from "../../../../../src/core/sync/protocol.ts";
import { createClient } from "../../../../../src/sdk/client.ts";

/** Opt-in, isolated fixture only. Start scripts/native-acceptance-server.ts;
 * Android requires adb reverse tcp:8991 tcp:8991. No production credentials. */
export async function runTransportDiagnostics(report: (message: string) => void) {
  const baseUrl = "http://127.0.0.1:8991";
  const token = "native-acceptance-local-only";
  const name = "transport-" + Date.now() + ".db";
  let db = new ExpoDriver(openDatabaseSync(name, nativeSqliteOpenOptions));
  initSchema(db);
  let service = createReplicaService(db);
  const remote = createClient({ baseUrl, token });
  try {
    const codeResponse = await fetch(baseUrl + "/api/pair/new", { method: "POST", headers: { authorization: "Bearer " + token } });
    if (!codeResponse.ok) throw new Error("pair code " + codeResponse.status);
    const { code } = await codeResponse.json();
    const pairResponse = await fetch(baseUrl + PAIR_PATH, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ code, node_id: getNodeId(db), grant: "native-acceptance-" + Date.now() }) });
    if (!pairResponse.ok) throw new Error("pair " + pairResponse.status);
    const pair = PairResponseSchema.parse(await pairResponse.json());
    const drain = async () => {
      for (let round = 0; round < 200; round++) {
        const result = await syncWithPeer(db, baseUrl, { token: pair.grant, pullLimit: 25, pushLimit: 25 });
        if (!result.pendingPush && (result.received ?? 0) < 25) return;
      }
      throw new Error("sync did not drain");
    };
    const table = await service.client.createDatabase({ name: "Native transport " + Date.now() });
    const prop = await service.client.addProperty(table.id, { name: "Title", type: "text" });
    const row = await service.client.createRecord(table.id, { [prop.id]: "offline native" });
    const doc = await service.client.createDocument({ title: "Native transport doc", body: "saved offline" });
    service.dispose(); db.close();
    db = new ExpoDriver(openDatabaseSync(name, nativeSqliteOpenOptions)); initSchema(db); service = createReplicaService(db);
    if ((await service.client.getRecord(row.id)).cells[prop.id] !== "offline native") throw new Error("offline reopen lost record");
    await drain();
    if ((await remote.getRecord(row.id)).cells[prop.id] !== "offline native") throw new Error("server missing mobile record");
    if ((await remote.getDocument(doc.id)).body !== "saved offline") throw new Error("server missing mobile document");
    report("PASS native pairing, offline write/reopen and bounded upload to Bun server");
    await remote.updateRecord(row.id, { [prop.id]: "desktop changed" });
    await remote.updateDocument(doc.id, { body: "desktop body" });
    await drain();
    if ((await service.client.getRecord(row.id)).cells[prop.id] !== "desktop changed") throw new Error("native missing server record update");
    if ((await service.client.getDocument(doc.id)).body !== "desktop body") throw new Error("native missing server document update");
    await drain();
    report("PASS Bun server record/document edits return to native replica; duplicate sync converges");
  } finally { service.dispose(); db.close(); }
}
