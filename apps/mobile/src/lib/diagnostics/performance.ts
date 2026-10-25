/** Opt-in debug emulator benchmark; timings are not production device claims. */
import { Platform } from "react-native";
import { openDatabaseSync } from "expo-sqlite";
import { File, Paths } from "expo-file-system";
import { initSchema } from "../../../../../src/core/schema-init.ts";
import { createReplicaService } from "../../../../../src/core/replica/service.ts";
import { ExpoDriver, nativeSqliteOpenOptions } from "../replica/expo-driver";

const yieldTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
export async function runNativePerformance() {
  const result: Record<string, unknown> = {
    environment: { platform: Platform.OS, platformVersion: Platform.Version, build: "debug", runtime: "Hermes", target: "simulator/emulator", bundle: "development Metro", performanceTargets: "Measured only; no production-device threshold pass asserted" },
    fixture: { records: 10000, documents: 1000, seedDispatchTransactionBatchSize: 10, searchIndexBatchSize: 25, scope: "service writes; not network sync ingest" },
  };
  const persist = () => new File(Paths.document, "native-performance.json").write(JSON.stringify(result, null, 2));
  const gaps: Record<string, number> = {};
  let phase = "setup", previous = performance.now();
  const setPhase = (next: string) => { phase = next; result.phase = next; persist(); };
  const timer = setInterval(() => {
    const now = performance.now();
    gaps[phase] = Math.max(gaps[phase] ?? 0, now - previous);
    previous = now;
  }, 10);
  const name = `performance-${Date.now()}.db`;
  let db = new ExpoDriver(openDatabaseSync(name, nativeSqliteOpenOptions));
  let service = createReplicaService(db, { searchBatchSize: 25 });
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    initSchema(db);
    const database = service.dispatch("createDatabase", [{ name: "Native performance fixture" }]);
    const field = service.dispatch("addProperty", [database.id, { name: "Title", type: "text" }]);
    setPhase("ingest");
    const ingestStart = performance.now();
    for (let base = 0; base < 11000; base += 10) {
      db.transaction(() => {
        for (let i = base; i < base + 10; i++) {
          if (i < 10000) service.dispatch("createRecord", [database.id, { [field.id]: `Benchmark record ${i} topic${i % 20}` }]);
          else service.dispatch("createDocument", [{ title: `Benchmark document ${i - 10000}`, body: `# Benchmark\n\nSearchable document topic${i % 20} fixture text.` }]);
        }
      })();
      if ((base + 10) % 100 === 0) { result.ingested = base + 10; persist(); }
      await yieldTurn();
    }
    result.ingestMs = performance.now() - ingestStart;
    const emittedOps = (db.query("SELECT count(*) AS n FROM crdt_changes").get() as { n: number }).n;
    result.emittedOps = emittedOps;
    if (emittedOps < 20000) throw new Error(`expected >=20k emitted ops, got ${emittedOps}`);
    setPhase("searchIndexWarmup");
    const indexStart = performance.now();
    await service.client.search("Benchmark", 20);
    result.searchIndexWarmupMs = performance.now() - indexStart;
    setPhase("warmSearch");
    const searchMs: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const hits = await service.client.search(`topic${i}`, 20);
      if (!hits.length) throw new Error(`missing search hits topic${i}`);
      searchMs.push(performance.now() - start);
      await yieldTurn();
    }
    result.warmSearch = { samplesMs: searchMs, p95Ms: [...searchMs].sort((a,b) => a-b)[18] };
    setPhase("pagedQueries");
    const queryStart = performance.now();
    let rows = 0;
    const pageMs: number[] = [];
    for (let offset = 0; offset < 10000; offset += 200) {
      const start = performance.now();
      const page = await service.client.queryRecords(database.id, { offset, limit: 200 });
      if (page.total !== 10000) throw new Error(`incorrect full-set total ${page.total}`);
      rows += page.records.length;
      pageMs.push(performance.now() - start);
    }
    if (rows !== 10000) throw new Error(`paged traversal returned ${rows} records`);
    result.fullSetPagedQuery = { pages: pageMs.length, rows, totalMs: performance.now() - queryStart, firstPageMs: pageMs[0], lastPageMs: pageMs.at(-1), p95PageMs: [...pageMs].sort((a,b) => a-b)[47] };
    service.dispose(); db.close();
    setPhase("databaseReopenHomeList");
    const reopenStart = performance.now();
    db = new ExpoDriver(openDatabaseSync(name, nativeSqliteOpenOptions));
    initSchema(db); service = createReplicaService(db, { searchBatchSize: 25 });
    const databases = await service.client.listDatabases();
    const documents = await service.client.queryDocuments({ limit: 60 });
    result.databaseReopenHomeList = { ms: performance.now() - reopenStart, databases: databases.length, documentSummaries: documents.documents.length, totalDocuments: documents.total, scope: "SQLite reopen, schema initialization, database list and first 60 document summaries; excludes app process cold start, React render and navigation" };
    await yieldTurn();
    result.functionalAssertions = "PASS";
    result.status = "COMPLETE";
    result.phase = "complete";
  } catch (error) {
    result.status = "FAIL";
    result.error = error instanceof Error ? error.stack : String(error);
  } finally {
    clearInterval(timer);
    result.maxObservedJsTimerGapMs = gaps;
    result.timerIntervalMs = 10;
    service.dispose(); db.close();
    persist();
  }
  return result;
}
