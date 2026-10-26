import { expect, test } from "bun:test";
import {
  createDiagnosticReportExporter,
  selectDiagnosticReport,
  type DiagnosticReportKind,
} from "./report-export-policy";
const start = Date.parse("2026-10-26T09:00:00.000Z");
const finish = start + 100;
const env = {
  artifactClass: "synthetic-native-diagnostics",
  platform: "android",
  configuration: "Release",
  bundle: "embedded Release bundle; no Metro",
};
const report = (kind: DiagnosticReportKind) => ({
  environment: env,
  status: "COMPLETE",
  measurementStartedAt: new Date(start).toISOString(),
  measurementFinishedAt: new Date(finish).toISOString(),
  ...(kind === "driver"
    ? { results: ["PASS driver"] }
    : { functionalAssertions: "PASS", fixture: { records: 5000 } }),
});

test("driver export is a whitelist, excludes the private crypto fixture and embedded benchmark JSON", () => {
  const input = {
    ...report("driver"),
    nativeFixture: { secret: "private generated envelope" },
    unknown: "private",
    environment: { ...env, token: "private" },
    results: [
      "PASS driver",
      "COMPLETE opt-in native network stress: private JSON",
    ],
  };
  const selected = selectDiagnosticReport("driver", input, start, finish);
  expect(selected.report).toEqual({
    ...report("driver"),
    exportCheckpoints: [],
  });
  expect(JSON.stringify(selected.report)).not.toContain("private");
  expect(input.nativeFixture.secret).toBe("private generated envelope");
});

test("malformed, stale, future and reversed measurement intervals never export", () => {
  for (const changed of [
    { measurementStartedAt: "not-a-date" },
    { measurementStartedAt: "0" },
    { measurementStartedAt: "2026-02-30T09:00:00.000Z" },
    { measurementStartedAt: new Date(start - 1).toISOString() },
    { measurementFinishedAt: "not-a-date" },
    { measurementFinishedAt: undefined },
    { measurementFinishedAt: new Date(start - 1).toISOString() },
    { measurementFinishedAt: new Date(finish + 1).toISOString() },
    { measurementStartedAt: new Date(finish + 1).toISOString() },
  ])
    expect(
      selectDiagnosticReport(
        "network",
        { ...report("network"), ...changed },
        start,
        finish,
      ).report,
    ).toBeUndefined();
  expect(
    selectDiagnosticReport("network", report("network"), NaN, finish).report,
  ).toBeUndefined();
});

test("running and foreign reports are skipped while a completed functional failure remains evidence", () => {
  expect(
    selectDiagnosticReport(
      "network",
      { ...report("network"), status: "RUNNING" },
      start,
      finish,
    ).report,
  ).toBeUndefined();
  expect(
    selectDiagnosticReport(
      "network",
      {
        ...report("network"),
        environment: { ...env, artifactClass: "normal" },
      },
      start,
      finish,
    ).report,
  ).toBeUndefined();
  const failed = {
    ...report("performance"),
    status: "FAIL",
    functionalAssertions: "FAIL lost rows",
    error: "lost rows",
    nativeFixture: "private",
  };
  const selected = selectDiagnosticReport("performance", failed, start, finish);
  expect(selected.report).toMatchObject({
    status: "FAIL",
    functionalAssertions: "FAIL lost rows",
    error: "lost rows",
  });
  expect(selected.report).not.toHaveProperty("nativeFixture");
});

test("driver exports before later reports exist; later terminal stages export once without stale files", async () => {
  const files: Partial<Record<"network" | "performance", unknown>> = {
    performance: {
      ...report("performance"),
      measurementStartedAt: new Date(start - 1000).toISOString(),
    },
  };
  const posts: DiagnosticReportKind[] = [];
  const send = createDiagnosticReportExporter({
    runStartedAt: start,
    now: () => finish,
    readReport: async (kind) => files[kind],
    verifyFixture: async () => {},
    post: async (kind) => {
      posts.push(kind);
    },
  });
  expect((await send(report("driver"))).exported).toEqual(["driver"]);
  expect(posts).toEqual(["driver"]);
  files.network = report("network");
  expect((await send(report("driver"))).exported).toEqual(["network"]);
  files.performance = report("performance");
  expect((await send(report("driver"))).exported).toEqual(["performance"]);
  expect((await send(report("driver"))).exported).toEqual([]);
  expect(posts).toEqual(["driver", "network", "performance"]);
});

test("failed delivery is separately reported and retried, without blocking another terminal report or changing assertions", async () => {
  let refuseDriver = true;
  const posts: DiagnosticReportKind[] = [];
  const driver = report("driver"),
    network = report("network");
  const send = createDiagnosticReportExporter({
    runStartedAt: start,
    now: () => finish,
    readReport: async (kind) => (kind === "network" ? network : undefined),
    verifyFixture: async () => {},
    post: async (kind) => {
      if (kind === "driver" && refuseDriver) throw new Error("HTTP 503");
      posts.push(kind);
    },
  });
  const first = await send(driver);
  expect(first.exported).toEqual(["network"]);
  expect(first.errors).toEqual([{ kind: "driver", message: "HTTP 503" }]);
  expect(driver).toHaveProperty("results", ["PASS driver"]);
  expect(network).toHaveProperty("functionalAssertions", "PASS");
  refuseDriver = false;
  expect((await send(driver)).exported).toEqual(["driver"]);
  expect(posts).toEqual(["network", "driver"]);
});

test("malformed local JSON is visible but does not prevent driver/performance delivery", async () => {
  const send = createDiagnosticReportExporter({
    runStartedAt: start,
    now: () => finish,
    readReport: async (kind) => {
      if (kind === "network") return JSON.parse("{");
      return report("performance");
    },
    verifyFixture: async () => {},
    post: async () => {},
  });
  const result = await send(report("driver"));
  expect(result.exported).toEqual(["driver", "performance"]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]?.kind).toBe("network");
});

test("an unverified relay receives nothing and failure does not mark reports as delivered", async () => {
  let verified = false,
    posts = 0;
  const send = createDiagnosticReportExporter({
    runStartedAt: start,
    now: () => finish,
    readReport: async () => undefined,
    verifyFixture: async () => {
      if (!verified) throw new Error("wrong fixture");
    },
    post: async () => {
      posts++;
    },
  });
  expect((await send(report("driver"))).errors).toEqual([
    { kind: "fixture", message: "wrong fixture" },
  ]);
  expect(posts).toBe(0);
  verified = true;
  expect((await send(report("driver"))).exported).toEqual(["driver"]);
  expect(posts).toBe(1);
});

test("export elapsed retains transport work as an explicit separate boundary", async () => {
  let clock = finish;
  const send = createDiagnosticReportExporter({
    runStartedAt: start,
    now: () => clock,
    readReport: async () => undefined,
    verifyFixture: async () => {
      clock += 7;
    },
    post: async () => {
      clock += 13;
    },
  });
  const result = await send(report("driver"));
  expect(result.elapsedMs).toBe(20);
  expect(Date.parse(result.finishedAt) - Date.parse(result.startedAt)).toBe(20);
});

test("driver export checkpoint metadata cannot carry unknown nested fixture fields", () => {
  const input = {
    ...report("driver"),
    exportCheckpoints: [
      {
        stage: "driver",
        elapsedMs: 20,
        nativeFixture: "private",
        exported: ["driver"],
        skipped: [],
        errors: [
          { kind: "fixture", message: "HTTP 503", nativeFixture: "private" },
        ],
      },
    ],
  };
  const selected = selectDiagnosticReport("driver", input, start, finish);
  expect(selected.report?.exportCheckpoints).toEqual([
    {
      stage: "driver",
      elapsedMs: 20,
      exported: ["driver"],
      skipped: [],
      errors: [{ kind: "fixture", message: "HTTP 503" }],
    },
  ]);
  expect(JSON.stringify(selected.report)).not.toContain("private");
});

test("a malformed terminal timestamp is visible as an export error and never posted", async () => {
  const posts: DiagnosticReportKind[] = [];
  const send = createDiagnosticReportExporter({
    runStartedAt: start,
    now: () => finish,
    readReport: async (kind) =>
      kind === "network"
        ? { ...report("network"), measurementFinishedAt: "invalid" }
        : undefined,
    verifyFixture: async () => {},
    post: async (kind) => {
      posts.push(kind);
    },
  });
  const result = await send(report("driver"));
  expect(posts).toEqual(["driver"]);
  expect(result.errors).toEqual([
    { kind: "network", message: "invalid measurement timestamp" },
  ]);
});
