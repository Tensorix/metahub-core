/** Pure synthetic-report policy and exporter; no native modules or global mocks. */
export type DiagnosticReportKind = "driver" | "network" | "performance";
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  !!value && typeof value === "object" && !Array.isArray(value);
const pick = (value: JsonObject, keys: readonly string[]) =>
  Object.fromEntries(
    keys.filter((key) => key in value).map((key) => [key, value[key]]),
  );
const pickScalars = (value: JsonObject, keys: readonly string[]) =>
  Object.fromEntries(
    keys
      .filter(
        (key) =>
          typeof value[key] === "string" ||
          (typeof value[key] === "number" && Number.isFinite(value[key])),
      )
      .map((key) => [key, value[key]]),
  );
const environmentKeys = [
  "artifactClass",
  "configuration",
  "build",
  "bundle",
  "platform",
  "platformVersion",
  "measurementScope",
  "runtime",
  "target",
  "transport",
  "performanceTargets",
] as const;
const reportKeys = [
  "measurementStartedAt",
  "measurementFinishedAt",
  "fixture",
  "status",
  "phase",
  "seededRecords",
  "seedMs",
  "queuedOps",
  "networkProgress",
  "upload",
  "network",
  "hydration",
  "searchIndex",
  "cursorReplay",
  "functionalAssertions",
  "error",
  "measurements",
  "maxObservedJsTimerGapMs",
  "timerIntervalMs",
  "jsTimerSamplesByPhase",
  "ingested",
  "ingestMs",
  "emittedOps",
  "searchIndexWarmupMs",
  "searchIndexSteps",
  "warmSearch",
  "fullSetPagedQuery",
  "databaseReopenHomeList",
] as const;
function safeCheckpoints(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter(object).map((checkpoint) => ({
    ...pickScalars(checkpoint, [
      "stage",
      "startedAt",
      "finishedAt",
      "elapsedMs",
    ]),
    exported: Array.isArray(checkpoint.exported)
      ? checkpoint.exported.filter((kind) =>
          ["driver", "network", "performance"].includes(kind),
        )
      : [],
    skipped: Array.isArray(checkpoint.skipped)
      ? checkpoint.skipped
          .filter(object)
          .map((item) => pickScalars(item, ["kind", "reason"]))
      : [],
    errors: Array.isArray(checkpoint.errors)
      ? checkpoint.errors
          .filter(object)
          .map((item) => pickScalars(item, ["kind", "message"]))
      : [],
  }));
}
function timestamp(value: unknown): number {
  // Native reports use ISO timestamps. Date.parse alone also accepts strings
  // such as "0", which must not be mistaken for a valid diagnostic timestamp.
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  )
    return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : NaN;
}
export function selectDiagnosticReport(
  kind: DiagnosticReportKind,
  value: unknown,
  runStartedAt: number,
  now: number,
): { report: JsonObject; reason?: never } | { report?: never; reason: string } {
  if (!object(value) || !object(value.environment))
    return { reason: "missing report/environment" };
  const env = value.environment;
  if (
    env.artifactClass !== "synthetic-native-diagnostics" ||
    !["ios", "android"].includes(String(env.platform))
  )
    return { reason: "not a native synthetic report" };
  const started = timestamp(value.measurementStartedAt),
    finished = timestamp(value.measurementFinishedAt);
  if (
    !Number.isFinite(runStartedAt) ||
    !Number.isFinite(now) ||
    !Number.isFinite(started) ||
    !Number.isFinite(finished)
  )
    return { reason: "invalid measurement timestamp" };
  if (started < runStartedAt) return { reason: "stale report" };
  if (finished < started || started > now || finished > now)
    return { reason: "invalid measurement interval" };
  if (value.status !== "COMPLETE" && value.status !== "FAIL")
    return { reason: "report is not terminal" };
  const environment = pickScalars(env, environmentKeys);
  if (kind === "driver") {
    if (
      !Array.isArray(value.results) ||
      !value.results.every((row) => typeof row === "string")
    )
      return { reason: "invalid driver results" };
    return {
      report: {
        environment,
        measurementStartedAt: value.measurementStartedAt,
        measurementFinishedAt: value.measurementFinishedAt,
        status: value.status,
        results: value.results.filter((row) => !row.includes("opt-in native")),
        // Only timing/status metadata is supplied here, never the private fixture.
        exportCheckpoints: safeCheckpoints(value.exportCheckpoints),
      },
    };
  }
  return { report: { environment, ...pick(value, reportKeys) } };
}
export interface DiagnosticExportOutcome {
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  exported: DiagnosticReportKind[];
  skipped: { kind: DiagnosticReportKind; reason: string }[];
  errors: { kind: DiagnosticReportKind | "fixture"; message: string }[];
}
export function createDiagnosticReportExporter(options: {
  runStartedAt: number;
  readReport(kind: "network" | "performance"): Promise<unknown | undefined>;
  verifyFixture(): Promise<void>;
  post(kind: DiagnosticReportKind, report: JsonObject): Promise<void>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const posted = new Map<DiagnosticReportKind, string>();
  return async (driver: unknown): Promise<DiagnosticExportOutcome> => {
    const start = now();
    const result: DiagnosticExportOutcome = {
      startedAt: new Date(start).toISOString(),
      finishedAt: "",
      elapsedMs: 0,
      exported: [],
      skipped: [],
      errors: [],
    };
    const candidates: {
      kind: DiagnosticReportKind;
      report: JsonObject;
      identity: string;
    }[] = [];
    for (const kind of ["driver", "network", "performance"] as const) {
      try {
        const raw = kind === "driver" ? driver : await options.readReport(kind);
        if (raw === undefined) {
          result.skipped.push({ kind, reason: "not available" });
          continue;
        }
        const selected = selectDiagnosticReport(
          kind,
          raw,
          options.runStartedAt,
          now(),
        );
        if (!selected.report) {
          result.skipped.push({ kind, reason: selected.reason });
          if (selected.reason.startsWith("invalid "))
            result.errors.push({ kind, message: selected.reason });
          continue;
        }
        const identity = JSON.stringify(selected.report);
        if (posted.get(kind) === identity) {
          result.skipped.push({ kind, reason: "already exported" });
          continue;
        }
        candidates.push({ kind, report: selected.report, identity });
      } catch (error) {
        result.errors.push({
          kind,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (candidates.length) {
      try {
        await options.verifyFixture();
      } catch (error) {
        result.errors.push({
          kind: "fixture",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (!result.errors.some((error) => error.kind === "fixture")) {
        for (const candidate of candidates) {
          try {
            await options.post(candidate.kind, candidate.report);
            posted.set(candidate.kind, candidate.identity);
            result.exported.push(candidate.kind);
          } catch (error) {
            result.errors.push({
              kind: candidate.kind,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
    const end = now();
    result.finishedAt = new Date(end).toISOString();
    result.elapsedMs = Math.max(0, end - start);
    return result;
  };
}
