/** Opt-in synthetic fixture. This never reads workspace sessions or user hubs.
 * Start bun scripts/replica-stress-server.ts; Android: adb reverse tcp:8992 tcp:8992.
 * Enable NETWORK_STRESS=1 with SELFTEST=1; Release also requires DIAGNOSTICS_RELEASE=1. */
import { createDiagnosticMeasurements } from "./performance-measure";
import { Platform } from "react-native";
import { openDatabaseSync, deleteDatabaseSync } from "expo-sqlite";
import { File, Paths } from "expo-file-system";
import { ExpoDriver, nativeSqliteOpenOptions } from "../replica/expo-driver";
import { initSchema } from "../../../../../src/core/schema-init.ts";
import { getNodeId } from "../../../../../src/core/node.ts";
import { createDatabase } from "../../../../../src/core/databases.ts";
import { addProperty } from "../../../../../src/core/properties.ts";
import { ingestDetailed, type Change } from "../../../../../src/core/crdt.ts";
import { formatHlc } from "../../../../../src/core/hlc.ts";
import { syncWithPeer } from "../../../../../src/core/sync/client.ts";
import {
  updateSearchIndexStep,
  querySearch,
} from "../../../../../src/core/search.ts";
import { updateRecord, getRecord } from "../../../../../src/core/records.ts";

const baseUrl = "http://127.0.0.1:8992";
const fixtureMarker = "metahub-isolated-native-network-v1";
const token = "native-network-stress-local-only";
const batchSize = 25;
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

export async function runNativeNetworkStress(
  onProgress?: (phase: string, detail?: string) => void,
) {
  const measurements = createDiagnosticMeasurements();
  const yieldTurn = () => measurements.measureAsyncElapsed("yield", turn);
  const result: Record<string, unknown> = {
    environment: {
      platform: Platform.OS,
      platformVersion: Platform.Version,
      runtime: "Hermes",
      build: __DEV__ ? "Debug" : "Release",
      artifactClass: "synthetic-native-diagnostics",
      bundle: __DEV__
        ? "development Metro"
        : "embedded Release bundle; no Metro",
      target: "record test device/emulator identity with artifact",
      transport: "real localhost HTTP to isolated production /sync fixture",
      performanceTargets:
        "Measured only; no production-device threshold pass asserted",
    },
    measurementStartedAt: new Date().toISOString(),
    fixture: {
      records: 5000,
      queuedOpsMinimum: 20000,
      networkBatchSize: batchSize,
      seed: "synthetic CRDT queue in 25-op synchronous batches; excludes UI-write cost",
    },
    status: "RUNNING",
  };
  const persist = () =>
    measurements.measureSync("reportWrite", () => {
      result.measurements = measurements.snapshot();
      new File(Paths.document, "native-network-stress.json").write(
        JSON.stringify(result, null, 2),
      );
    });
  const request = async (path: string, body?: unknown) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(baseUrl + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`fixture ${path}: ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  };
  const name = `network-stress-${Date.now()}.db`;
  let activeName = name;
  const receiverName = `network-stress-receiver-${Date.now()}.db`;
  let db: ExpoDriver | undefined;
  let node: string | undefined;
  let inFlight: AbortController | undefined;
  const open = () =>
    measurements.measureSync("sqliteOpenAndSchema", () => {
      const driver = new ExpoDriver(
        openDatabaseSync(activeName, nativeSqliteOpenOptions),
      );
      driver.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      initSchema(driver);
      return driver;
    });
  let phase = "setup",
    previous = performance.now();
  const gaps: Record<string, number> = {};
  const timerSamples: Record<string, number> = {};
  const timer = setInterval(() => {
    measurements.sampleTimer();
    timerSamples[phase] = (timerSamples[phase] ?? 0) + 1;
    const now = performance.now();
    gaps[phase] = Math.max(gaps[phase] ?? 0, now - previous);
    previous = now;
  }, 10);
  const setPhase = (next: string) => {
    phase = next;
    measurements.setPhase(next);
    result.phase = next;
    persist();
    onProgress?.(next);
  };
  try {
    const marker = await request("/fixture");
    check(
      marker.fixture === fixtureMarker && marker.isolated === true,
      "not the isolated network stress server",
    );
    db = open();
    node = getNodeId(db);
    const table = createDatabase(db, {
      name: `Native network fixture ${node}`,
    });
    const title = addProperty(db, table.id, { name: "Title", type: "text" });
    const number = addProperty(db, table.id, {
      name: "Number",
      type: "number",
    });
    const count = () =>
      (
        db!.query("SELECT count(*) AS n FROM crdt_changes").get() as {
          n: number;
        }
      ).n;
    const cursor = () =>
      JSON.stringify(
        db!
          .query("SELECT pull_cursor,push_cursor FROM peers WHERE url=?")
          .get(baseUrl),
      );
    const sourceNode = node;
    const recordId = (i: number) =>
      `rec_network_${sourceNode}_${String(i).padStart(6, "0")}`;
    setPhase("seedQueue");
    const seedStart = performance.now(),
      millis = Date.now() - 1000;
    let seq = 0,
      pending: Change[] = [];
    for (let i = 0; i < 5000; i++) {
      for (const [col, value] of [
        ["database_id", table.id],
        ["order_key", String(i).padStart(8, "0")],
        [title.id, `Network record ${i}`],
        [number.id, i],
      ] as [string, string | number][]) {
        pending.push({
          hlc: formatHlc({ millis, counter: seq++, node }),
          node_id: node,
          dataset: "records",
          row_id: recordId(i),
          col,
          value: JSON.stringify(value),
          txn: "network-fixture",
        });
        if (pending.length === batchSize) {
          measurements.measureSync("seedIngest", () =>
            ingestDetailed(db!, pending),
          );
          pending = [];
          await yieldTurn();
        }
      }
      if (i % 250 === 249) {
        result.seededRecords = i + 1;
        persist();
        onProgress?.(phase, `${i + 1}/5000 records`);
      }
    }
    if (pending.length)
      measurements.measureSync("seedIngest", () =>
        ingestDetailed(db!, pending),
      );
    result.seedMs = performance.now() - seedStart;
    result.queuedOps = count();
    check(count() >= 20000, "missing queued ops");
    const sync = (signal?: AbortSignal) =>
      measurements.measureAsyncElapsed("syncRound", () =>
        syncWithPeer(db!, baseUrl, {
          token,
          pushLimit: batchSize,
          pullLimit: batchSize,
          signal,
          measureSync: (stage, run) =>
            measurements.measureSync("sync." + stage, run),
        }),
      );
    const fault = (mode: string) => request("/fixture/fault", { node, mode });
    const stats = () =>
      request(
        `/fixture/stats?node=${encodeURIComponent(node!)}&database=${encodeURIComponent(table.id)}`,
      );
    const drain = async () => {
      let rounds = 0,
        pushed = 0,
        pulled = 0;
      const start = performance.now();
      do {
        const page = await sync();
        rounds++;
        pushed += page.pushed;
        pulled += page.pulled;
        if (!page.pendingPush && (page.received ?? 0) < batchSize)
          return { rounds, pushed, pulled, ms: performance.now() - start };
        if (rounds % 50 === 0) {
          result.networkProgress = { phase, rounds, pushed, pulled };
          persist();
          onProgress?.(
            phase,
            `${rounds} rounds; pushed ${pushed}; pulled ${pulled}`,
          );
        }
        await yieldTurn();
      } while (rounds < 2000);
      throw new Error("network queue did not drain");
    };
    setPhase("offlineBeforeUpload");
    const beforeOffline = cursor();
    await fault("offline");
    let failed = false;
    try {
      await sync();
    } catch {
      failed = true;
    }
    check(
      failed && cursor() === beforeOffline,
      "offline upload advanced cursors",
    );
    await fault("none");
    setPhase("networkUpload");
    result.upload = await drain();
    const uploaded = await stats();
    check(
      uploaded.uniqueUploadedOps >= 20000 &&
        uploaded.records === 5000 &&
        uploaded.maxUploadedPage <= batchSize,
      "server did not receive the entire bounded queue",
    );
    result.network = uploaded;
    onProgress?.("networkUpload/close-sender");
    db.close();
    db = undefined;
    activeName = receiverName;
    onProgress?.("networkUpload/open-receiver");
    db = open();
    node = getNodeId(db);
    setPhase("networkHydration");
    const hydration = await drain();
    check(
      hydration.pulled >= 20000 &&
        getRecord(db, recordId(4999))?.cells[title.id] ===
          "Network record 4999",
      "native network hydration lost queued records",
    );
    result.hydration = hydration;
    setPhase("searchIndexWarmup");
    const indexStart = performance.now();
    const indexSteps: number[] = [];
    while (true) {
      const start = performance.now();
      const step = measurements.measureSync("searchIndexStep", () =>
        updateSearchIndexStep(db!, batchSize),
      );
      indexSteps.push(performance.now() - start);
      if (step.ready) break;
      await yieldTurn();
    }
    const sortedSteps = [...indexSteps].sort((a, b) => a - b);
    check(
      querySearch(db, "Network", { maintainIndex: false }).hits.length > 0,
      "indexed native network rows missing",
    );
    result.searchIndex = {
      batchSize,
      totalMs: performance.now() - indexStart,
      steps: indexSteps.length,
      maxStepMs: Math.max(...indexSteps),
      p95StepMs:
        sortedSteps[Math.max(0, Math.ceil(sortedSteps.length * 0.95) - 1)],
    };
    setPhase("lostAckReplay");
    measurements.measureSync("localRecordUpdate", () =>
      updateRecord(db!, recordId(0), { [title.id]: "Retry after lost ack" }),
    );
    const beforeLost = cursor();
    await fault("lost-response");
    failed = false;
    try {
      await sync();
    } catch {
      failed = true;
    }
    check(failed && cursor() === beforeLost, "lost ack advanced cursors");
    await drain();
    setPhase("inFlightInterruption");
    measurements.measureSync("localRecordUpdate", () =>
      updateRecord(db!, recordId(1), { [title.id]: "Survive interruption" }),
    );
    const beforeAbort = cursor();
    await fault("held-response");
    const controller = (inFlight = new AbortController());
    const pendingSync = sync(controller.signal).then(
      () => false,
      () => true,
    );
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      if ((await stats()).waiting) {
        waiting = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    controller.abort(new Error("native fixture background interruption"));
    onProgress?.("inFlightInterruption/await-abort");
    check(await pendingSync, "in-flight operation ignored cancellation");
    inFlight = undefined;
    check(
      waiting && cursor() === beforeAbort,
      "interrupted page advanced cursors",
    );
    onProgress?.("inFlightInterruption/close");
    db.close();
    db = undefined;
    await fault("none");
    await yieldTurn();
    onProgress?.("inFlightInterruption/reopen");
    db = open();
    check(
      cursor() === beforeAbort &&
        getRecord(db, recordId(1))?.cells[title.id] === "Survive interruption",
      "reopen lost pending data/cursors",
    );
    await drain();
    setPhase("allKnownCursorReplay");
    const beforeReplay = count();
    db.query("UPDATE peers SET pull_cursor=0 WHERE url=?").run(baseUrl);
    const replay = await drain();
    check(
      replay.pulled === 0 && replay.rounds > 800 && count() === beforeReplay,
      "known full-page replay duplicated/lost changes",
    );
    result.cursorReplay = replay;
    await fault("unauthorized");
    const beforeAuth = cursor();
    failed = false;
    try {
      await sync();
    } catch (error) {
      failed = (error as { code?: string }).code === "auth";
    }
    check(failed && cursor() === beforeAuth, "auth failure changed cursors");
    await fault("none");
    result.functionalAssertions =
      "PASS >=20k unique network ops, bounded pages, offline writes, lost ack replay, in-flight close/reopen recovery, all-known cursor replay and auth failure";
    result.status = "COMPLETE";
    result.phase = "complete";
  } catch (error) {
    result.status = "FAIL";
    result.error = error instanceof Error ? error.stack : String(error);
  } finally {
    inFlight?.abort(new Error("native fixture disposed"));
    measurements.sampleTimer();
    clearInterval(timer);
    result.maxObservedJsTimerGapMs = gaps;
    result.timerIntervalMs = 10;
    result.jsTimerSamplesByPhase = timerSamples;
    result.measurementFinishedAt = new Date().toISOString();
    if (node) {
      onProgress?.("cleanup/fault-reset");
      try {
        await request("/fixture/fault", { node, mode: "none" });
      } catch {}
    }
    onProgress?.("cleanup/close");
    db?.close();
    let deleted = 0;
    for (const fixtureName of [name, receiverName]) {
      onProgress?.("cleanup/delete", `${++deleted}/2 fixture databases`);
      try {
        deleteDatabaseSync(fixtureName);
      } catch {}
    }
    onProgress?.("cleanup/reportWrite");
    persist();
    onProgress?.(String(result.phase ?? phase), String(result.status));
  }
  return result;
}
