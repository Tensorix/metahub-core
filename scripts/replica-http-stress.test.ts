import { test, expect } from "bun:test";
import { runReplicaHttpStress } from "./replica-http-stress.ts";

test("real HTTP transports >=20k queued ops and recovers offline, replay, interruption, divergence and cursors", async () => {
  const report = await runReplicaHttpStress();
  expect(report.functionalAssertions).toBe("PASS");
  expect(report.fixture.queuedOps).toBeGreaterThanOrEqual(20_000);
  expect(report.network.uniqueUploadedOps).toBeGreaterThanOrEqual(20_000);
  expect(report.network.maxUploadedPage).toBeLessThanOrEqual(200);
  expect(report.network.maxDownloadedPage).toBeLessThanOrEqual(200);
  expect(report.resetReplay.pulled).toBe(0);
  expect(report.resetReplay.rounds).toBeGreaterThan(100);
  expect(report.assertions).toHaveLength(7);
  // Work bounds are deterministic; host-specific timing thresholds are not.
  expect(report.uploadSql.ackPrefixRows).toBeLessThanOrEqual(report.upload.rounds * report.fixture.batchSize);
  expect(report.uploadSql.clockReads).toBeLessThanOrEqual(report.upload.rounds);
  expect(report.uploadSql.clockWrites).toBeLessThanOrEqual(report.upload.rounds);
  expect(report.environment.nativePerformanceClaim).toBe(false);
}, 30_000);
