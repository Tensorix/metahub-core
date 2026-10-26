/** Opt-in synthetic benchmark. Fixed embedded Release runs are distinct from normal app/UI acceptance. */
import { createDiagnosticMeasurements } from "./performance-measure";
import { Platform } from "react-native";
import { openDatabaseSync } from "expo-sqlite";
import { File, Paths } from "expo-file-system";
import { initSchema } from "../../../../../src/core/schema-init.ts";
import {
  updateSearchIndexStep,
  search,
} from "../../../../../src/core/search.ts";
import { createReplicaService } from "../../../../../src/core/replica/service.ts";
import { ExpoDriver, nativeSqliteOpenOptions } from "../replica/expo-driver";

const yieldTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
export async function runNativePerformance(
  onProgress?: (phase: string, detail?: string) => void,
) {
  const measurements = createDiagnosticMeasurements();
  const measuredYield = () =>
    measurements.measureAsyncElapsed("yield", yieldTurn);
  const result: Record<string, unknown> = {
    environment: {
      platform: Platform.OS,
      platformVersion: Platform.Version,
      build: __DEV__ ? "Debug" : "Release",
      artifactClass: "synthetic-native-diagnostics",
      runtime: "Hermes",
      target: "record test device/emulator identity with artifact",
      bundle: __DEV__
        ? "development Metro"
        : "embedded Release bundle; no Metro",
      performanceTargets:
        "Measured only; no production-device threshold pass asserted",
    },
    measurementStartedAt: new Date().toISOString(),
    fixture: {
      records: 10000,
      documents: 1000,
      seedDispatchTransactionBatchSize: 10,
      searchIndexBatchSize: 25,
      scope: "service writes; not network sync ingest",
    },
  };
  const persist = () =>
    measurements.measureSync("reportWrite", () => {
      result.measurements = measurements.snapshot();
      new File(Paths.document, "native-performance.json").write(
        JSON.stringify(result, null, 2),
      );
    });
  const gaps: Record<string, number> = {};
  const timerSamples: Record<string, number> = {};
  let phase = "setup",
    previous = performance.now();
  const setPhase = (next: string) => {
    phase = next;
    measurements.setPhase(next);
    result.phase = next;
    persist();
    onProgress?.(next);
  };
  const timer = setInterval(() => {
    measurements.sampleTimer();
    const now = performance.now();
    timerSamples[phase] = (timerSamples[phase] ?? 0) + 1;
    gaps[phase] = Math.max(gaps[phase] ?? 0, now - previous);
    previous = now;
  }, 10);
  const name = `performance-${Date.now()}.db`;
  let db = measurements.measureSync(
    "sqliteOpen",
    () => new ExpoDriver(openDatabaseSync(name, nativeSqliteOpenOptions)),
  );
  let service = measurements.measureSync("replicaServiceCreate", () =>
    createReplicaService(db, { searchBatchSize: 25 }),
  );
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    measurements.measureSync("schemaInit", () => initSchema(db));
    const database = service.dispatch("createDatabase", [
      { name: "Native performance fixture" },
    ]);
    const field = service.dispatch("addProperty", [
      database.id,
      { name: "Title", type: "text" },
    ]);
    setPhase("ingest");
    const ingestStart = performance.now();
    for (let base = 0; base < 11000; base += 10) {
      measurements.measureSync("seedDispatchBatch", () =>
        db.transaction(() => {
          for (let i = base; i < base + 10; i++) {
            if (i < 10000)
              service.dispatch("createRecord", [
                database.id,
                { [field.id]: `Benchmark record ${i} topic${i % 20}` },
              ]);
            else
              service.dispatch("createDocument", [
                {
                  title: `Benchmark document ${i - 10000}`,
                  body: `# Benchmark\n\nSearchable document topic${i % 20} fixture text.`,
                },
              ]);
          }
        })(),
      );
      if ((base + 10) % 100 === 0) {
        result.ingested = base + 10;
        persist();
        onProgress?.(phase, `${base + 10}/11000 items`);
      }
      await measuredYield();
    }
    result.ingestMs = performance.now() - ingestStart;
    const emittedOps = (
      db.query("SELECT count(*) AS n FROM crdt_changes").get() as { n: number }
    ).n;
    result.emittedOps = emittedOps;
    if (emittedOps < 20000)
      throw new Error(`expected >=20k emitted ops, got ${emittedOps}`);
    setPhase("searchIndexWarmup");
    const indexStart = performance.now();
    const indexSteps: number[] = [];
    while (true) {
      const stepStart = performance.now();
      const step = measurements.measureSync("searchIndexStep", () =>
        updateSearchIndexStep(db, 25),
      );
      indexSteps.push(performance.now() - stepStart);
      if (step.ready) break;
      await measuredYield();
    }
    if (!search(db, "Benchmark", { limit: 20, maintainIndex: false }).length)
      throw new Error("index warmup missing fixture rows");
    result.searchIndexWarmupMs = performance.now() - indexStart;
    const orderedSteps = [...indexSteps].sort((a, b) => a - b);
    result.searchIndexSteps = {
      count: indexSteps.length,
      batchSize: 25,
      maxMs: Math.max(...indexSteps),
      p95Ms:
        orderedSteps[Math.max(0, Math.ceil(orderedSteps.length * 0.95) - 1)],
    };
    setPhase("warmSearch");
    const searchMs: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const hits = await measurements.measureAsyncEntry("warmSearch", () =>
        service.client.search(`topic${i}`, 20),
      );
      if (!hits.length) throw new Error(`missing search hits topic${i}`);
      searchMs.push(performance.now() - start);
      await measuredYield();
    }
    result.warmSearch = {
      count: searchMs.length,
      samplesMs: searchMs,
      p95Ms: [...searchMs].sort((a, b) => a - b)[18],
    };
    setPhase("pagedQueries");
    const queryStart = performance.now();
    let rows = 0;
    const pageMs: number[] = [];
    for (let offset = 0; offset < 10000; offset += 200) {
      const start = performance.now();
      const page = await measurements.measureAsyncEntry("recordPage", () =>
        service.client.queryRecords(database.id, { offset, limit: 200 }),
      );
      if (page.total !== 10000)
        throw new Error(`incorrect full-set total ${page.total}`);
      rows += page.records.length;
      pageMs.push(performance.now() - start);
    }
    if (rows !== 10000)
      throw new Error(`paged traversal returned ${rows} records`);
    result.fullSetPagedQuery = {
      pages: pageMs.length,
      rows,
      totalMs: performance.now() - queryStart,
      firstPageMs: pageMs[0],
      lastPageMs: pageMs.at(-1),
      p95PageMs: [...pageMs].sort((a, b) => a - b)[47],
    };
    onProgress?.("pagedQueries/service-dispose");
    service.dispose();
    onProgress?.("pagedQueries/close");
    db.close();
    setPhase("databaseReopenHomeList");
    const reopenStart = performance.now();
    db = measurements.measureSync(
      "sqliteReopen",
      () => new ExpoDriver(openDatabaseSync(name, nativeSqliteOpenOptions)),
    );
    measurements.measureSync("schemaInit", () => initSchema(db));
    service = measurements.measureSync("replicaServiceCreate", () =>
      createReplicaService(db, { searchBatchSize: 25 }),
    );
    const databases = await measurements.measureAsyncEntry(
      "listDatabases",
      () => service.client.listDatabases(),
    );
    const documents = await measurements.measureAsyncEntry(
      "queryDocuments",
      () => service.client.queryDocuments({ limit: 60 }),
    );
    result.databaseReopenHomeList = {
      ms: performance.now() - reopenStart,
      databases: databases.length,
      documentSummaries: documents.documents.length,
      totalDocuments: documents.total,
      scope:
        "SQLite reopen, schema initialization, database list and first 60 document summaries; excludes app process cold start, React render and navigation",
    };
    await measuredYield();
    result.functionalAssertions = "PASS";
    result.status = "COMPLETE";
    result.phase = "complete";
  } catch (error) {
    result.status = "FAIL";
    result.error = error instanceof Error ? error.stack : String(error);
  } finally {
    measurements.sampleTimer();
    clearInterval(timer);
    result.maxObservedJsTimerGapMs = gaps;
    result.timerIntervalMs = 10;
    result.jsTimerSamplesByPhase = timerSamples;
    result.measurementFinishedAt = new Date().toISOString();
    onProgress?.("cleanup/service-dispose");
    service.dispose();
    onProgress?.("cleanup/close");
    db.close();
    onProgress?.("cleanup/reportWrite");
    persist();
    onProgress?.(String(result.phase ?? phase), String(result.status));
  }
  return result;
}
