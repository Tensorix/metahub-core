import { expect, test } from "bun:test";
import { createDiagnosticMeasurements } from "./performance-measure";

test("sync and async wall time stay separate and timer gaps retain unmeasured time", async () => {
  let time = 0;
  const timing = createDiagnosticMeasurements(() => time);
  timing.setPhase("networkUpload");
  timing.measureSync("prepare", () => {
    time += 3;
  });
  let release!: () => void;
  const waiting = timing.measureAsyncElapsed(
    "request",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  time += 100;
  timing.sampleTimer();
  release();
  await waiting;
  const result = timing.snapshot();
  expect(result.synchronousByPhase["networkUpload/prepare"]).toEqual({
    count: 1,
    failed: 0,
    totalMs: 3,
    maxMs: 3,
    p95Ms: 3,
  });
  expect(result.asyncElapsedByPhase["networkUpload/request"]?.maxMs).toBe(100);
  expect(result.largestTimerGaps[0]).toMatchObject({
    durationMs: 103,
    measuredRootSyncWallMs: 3,
    unmeasuredWallMs: 100,
  });
  expect(result.largestTimerGaps[0]?.activeAsync[0]?.operation).toBe("request");
});

test("nested measurements do not double count timer coverage and failures keep identity", () => {
  let time = 0;
  const timing = createDiagnosticMeasurements(() => time);
  const original = new Error("write failure");
  let failure: unknown;
  try {
    timing.measureSync("batch", () => {
      time += 2;
      timing.measureSync("statement", () => {
        time += 3;
      });
      time += 4;
      throw original;
    });
  } catch (error) {
    failure = error;
  }
  timing.sampleTimer();
  expect(failure).toBe(original);
  const result = timing.snapshot();
  expect(result.synchronousByPhase["setup/batch"]?.failed).toBe(1);
  expect(result.synchronousByPhase["setup/statement"]?.totalMs).toBe(3);
  expect(result.largestTimerGaps[0]?.measuredRootSyncWallMs).toBe(9);
});

test("sync spans reject Promises and async entry measures only the immediate invocation", async () => {
  let time = 0;
  const timing = createDiagnosticMeasurements(() => time);
  expect(() => timing.measureSync("invalid", () => Promise.resolve())).toThrow(
    "must not return a Promise",
  );
  let release!: () => void;
  const result = timing.measureAsyncEntry("query", () => {
    time += 5;
    return new Promise<number>((resolve) => {
      release = () => resolve(42);
    });
  });
  time += 90;
  release();
  expect(await result).toBe(42);
  const snapshot = timing.snapshot();
  expect(snapshot.synchronousByPhase["setup/invalid"]).toBeUndefined();
  expect(snapshot.synchronousByPhase["setup/query.entry"]?.totalMs).toBe(5);
  expect(snapshot.asyncElapsedByPhase["setup/query.elapsed"]?.totalMs).toBe(95);
});

test("phase transitions and bounded evidence keep cross-phase gaps visible", () => {
  let time = 0;
  const timing = createDiagnosticMeasurements(() => time);
  for (let i = 0; i < 30; i++) {
    timing.setPhase(i % 2 ? "upload" : "hydration");
    timing.measureSync("ingest", () => {
      time += i + 1;
    });
    time += 10;
    timing.sampleTimer();
  }
  const result = timing.snapshot();
  expect(result.slowestSynchronousCalls).toHaveLength(12);
  expect(result.largestTimerGaps).toHaveLength(12);
  expect(result.largestTimerGaps[0]?.fromPhase).toBe("hydration");
  expect(result.largestTimerGaps[0]?.toPhase).toBe("upload");
  expect(result.synchronousByPhase["upload/ingest"]?.count).toBe(15);
});

test("completed async spans remain evidence when an await resolves before the delayed timer callback", async () => {
  let time = 0;
  const timing = createDiagnosticMeasurements(() => time);
  await timing.measureAsyncElapsed("response", async () => {
    time += 2000;
  });
  timing.measureSync("ingest", () => {
    time += 4;
  });
  timing.sampleTimer();
  const result = timing.snapshot();
  expect(result.largestTimerGaps[0]?.activeAsync).toEqual([]);
  expect(
    result.largestTimerGaps[0]?.longestCompletedAsyncElapsed[0],
  ).toMatchObject({ operation: "response", durationMs: 2000 });
  expect(result.largestTimerGaps[0]?.unmeasuredWallMs).toBe(2000);
  expect(result.slowestAsyncElapsed[0]?.durationMs).toBe(2000);
});
