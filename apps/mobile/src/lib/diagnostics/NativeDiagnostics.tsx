/** Opt-in development build diagnostics. Never executed in production. */
import { useEffect, useState } from "react";
import { ScrollView, Text } from "react-native";
import { openDatabaseSync } from "expo-sqlite";
import { File, Paths } from "expo-file-system";
import { driverContractCases } from "../../../../../src/room/driver-contract.ts";
import { initSchema } from "../../../../../src/core/schema-init.ts";
import { createReplicaService } from "../../../../../src/core/replica/service.ts";
import {
  generateMasterKey,
  wrapMasterKey,
  unwrapMasterKey,
  encryptBytes,
  decryptBytes,
  fromB64,
  toB64,
  type KeyEnvelope,
} from "../../../../../src/core/sync/e2ee.ts";
import { ExpoDriver, nativeSqliteOpenOptions } from "../replica/expo-driver";
import { initializeNativeSyncRuntime } from "../sync/runtime";
import { nativeStorageCodec } from "../sync/codec";
import fixture from "./crypto-fixture.json";
import { runNativePerformance } from "./performance";
import { runTransportDiagnostics } from "./transport";
let resultPromise: Promise<string[]> | undefined;
async function run() {
  const results: string[] = [];
  let nativeFixture: unknown;
  const report = () =>
    new File(Paths.document, "native-diagnostics.json").write(
      JSON.stringify({ at: new Date().toISOString(), results, nativeFixture }, null, 2),
    );
  try {
    await initializeNativeSyncRuntime();
    for (const test of driverContractCases()) {
      const db = new ExpoDriver(openDatabaseSync(":memory:", nativeSqliteOpenOptions));
      try {
        test.fn(db);
        results.push(`PASS ${test.name}`);
      } finally {
        report();
        db.close();
      }
    }
    const name = `diagnostics-${Date.now()}.db`;
    let db = new ExpoDriver(openDatabaseSync(name, nativeSqliteOpenOptions));
    initSchema(db);
    let service = createReplicaService(db);
    const database = await service.client.createDatabase({
      name: "原生离线验收",
    });
    const field = await service.client.addProperty(database.id, {
      name: "标题",
      type: "text",
    });
    const record = await service.client.createRecord(database.id, {
      [field.id]: "offline",
    });
    const doc = await service.client.createDocument({
      title: "离线文档",
      body: "# Hello\n\n持久化测试",
    });
    service.drafts.checkpointDocument(doc.id, {
      revision: 2,
      title: doc.title,
      body: "recovered",
      version: doc.version,
    });
    service.drafts.acknowledgeDocument(doc.id, 1);
    service.dispose();
    db.close();
    db = new ExpoDriver(openDatabaseSync(name, nativeSqliteOpenOptions));
    initSchema(db);
    service = createReplicaService(db);
    if (
      (await service.client.getRecord(record.id)).cells[field.id] !== "offline"
    )
      throw new Error("record reopen failed");
    if (service.drafts.readDocument(doc.id)?.body !== "recovered")
      throw new Error("draft reopen failed");
    results.push("PASS native schema, CRUD, durable checkpoint and reopen");
    service.dispose();
    db.close();
    for (let cycle = 0; cycle < 3; cycle++) {
      db = new ExpoDriver(openDatabaseSync(name, nativeSqliteOpenOptions));
      initSchema(db);
      // Exercise the FTS virtual table and its internally owned statements.
      db.query("SELECT rowid FROM search_fts WHERE search_fts MATCH ?").all("Hello");
      const replica = createReplicaService(db);
      if ((await replica.client.getRecord(record.id)).cells[field.id] !== "offline")
        throw new Error(`schema reopen cycle ${cycle} lost record`);
      replica.dispose();
      db.close();
    }
    results.push("PASS three FTS schema close/reopen cycles");
    report();
    const bunKey = await unwrapMasterKey(fixture.envelope as KeyEnvelope, fixture.passphrase);
    if (toB64(bunKey) !== fixture.key) throw new Error("Bun key envelope incompatible");
    const bunPlain = await nativeStorageCodec.gunzip(await decryptBytes(bunKey, fromB64(fixture.payload)));
    if (new TextDecoder().decode(bunPlain) !== fixture.text) throw new Error("Bun payload incompatible");
    results.push("PASS Bun-generated PBKDF2 envelope and encrypted gzip decoded natively");
    report();
    const key = generateMasterKey(),
      envelope = await wrapMasterKey(key, "手机跨端密码🔑"),
      restored = await unwrapMasterKey(envelope, "手机跨端密码🔑");
    if (String(key) !== String(restored))
      throw new Error("native PBKDF2 envelope mismatch");
    const plain = new TextEncoder().encode("native encrypted gzip 你好"),
      payload = await encryptBytes(key, await nativeStorageCodec.gzip(plain));
    const decoded = await nativeStorageCodec.gunzip(
      await decryptBytes(key, payload),
    );
    if (String(plain) !== String(decoded))
      throw new Error("native crypto codec mismatch");
    results.push("PASS native PBKDF2, AES-GCM, gzip roundtrip");
    nativeFixture = { envelope, payload: toB64(payload), text: new TextDecoder().decode(plain) };
    report();
    let refused = false;
    try {
      await unwrapMasterKey(envelope, "wrong");
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("wrong password accepted");
    results.push("PASS incorrect passphrase rejected");
    report();
    if (process.env.EXPO_PUBLIC_MH_TRANSPORT === "1") {
      await runTransportDiagnostics(message => { results.push(message); report(); });
    }
    if (process.env.EXPO_PUBLIC_MH_PERF === "1") {
      const performanceResult = await runNativePerformance();
      results.push(`${performanceResult.status} opt-in native performance: ${JSON.stringify(performanceResult)}`);
    }
  } catch (e) {
    results.push(`FAIL ${e instanceof Error ? e.stack : String(e)}`);
  }
  report();
  return results;
}
export function NativeDiagnostics() {
  const [rows, setRows] = useState<string[]>(["Running native diagnostics…"]);
  useEffect(() => {
    resultPromise ??= run();
    void resultPromise.then(setRows);
  }, []);
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: "white" }}
      contentContainerStyle={{ padding: 30, paddingTop: 70 }}
    >
      {rows.map((s, i) => (
        <Text
          key={i}
          selectable
          style={{
            color: s.startsWith("FAIL") ? "red" : "black",
            marginBottom: 10,
          }}
        >
          {s}
        </Text>
      ))}
    </ScrollView>
  );
}
