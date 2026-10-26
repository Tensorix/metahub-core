/** Wall-clock evidence for synthetic diagnostics. Sync calls include native SQL
 * waits and OS descheduling; they are not a JS CPU profiler. Awaited elapsed
 * spans overlap sync spans and are never counted as event-loop blocking. */
interface Span {
  phase: string;
  operation: string;
  startedMs: number;
  durationMs: number;
  failed: boolean;
}
interface Samples {
  values: number[];
  failed: number;
}
const top = <T>(
  items: T[],
  value: T,
  duration: (item: T) => number,
  limit = 12,
) => {
  items.push(value);
  items.sort((a, b) => duration(b) - duration(a));
  if (items.length > limit) items.length = limit;
};
const summary = (samples: Samples) => {
  const ordered = [...samples.values].sort((a, b) => a - b);
  return {
    count: ordered.length,
    failed: samples.failed,
    totalMs: ordered.reduce((sum, value) => sum + value, 0),
    maxMs: ordered.at(-1) ?? 0,
    p95Ms: ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0,
  };
};
export function createDiagnosticMeasurements(
  now: () => number = () => performance.now(),
) {
  const origin = now();
  let phase = "setup",
    depth = 0,
    previousTick = origin,
    previousPhase = phase;
  let rootSyncMs = 0;
  const sync = new Map<string, Samples>(),
    asyncElapsed = new Map<string, Samples>();
  const slowestSync: Span[] = [],
    syncSinceTick: Span[] = [],
    slowestAsync: Span[] = [],
    asyncSinceTick: Span[] = [];
  const activeAsync = new Map<
    number,
    { phase: string; operation: string; start: number }
  >();
  let sequence = 0;
  const timerGaps: {
    fromPhase: string;
    toPhase: string;
    durationMs: number;
    measuredRootSyncWallMs: number;
    unmeasuredWallMs: number;
    longestMeasuredSyncCalls: Span[];
    longestCompletedAsyncElapsed: Span[];
    activeAsync: { phase: string; operation: string; elapsedMs: number }[];
  }[] = [];
  const add = (
    map: Map<string, Samples>,
    key: string,
    duration: number,
    failed: boolean,
  ) => {
    let samples = map.get(key);
    if (!samples) {
      samples = { values: [], failed: 0 };
      map.set(key, samples);
    }
    samples.values.push(duration);
    if (failed) samples.failed++;
  };
  const measureSync = <T>(operation: string, run: () => T): T => {
    const captured = phase,
      start = now(),
      root = depth++ === 0;
    let failed = false,
      valid = true;
    try {
      const result = run();
      if (
        result &&
        (typeof result === "object" || typeof result === "function") &&
        typeof (result as { then?: unknown }).then === "function"
      ) {
        valid = false;
        throw new TypeError(
          "A synchronous diagnostic span must not return a Promise",
        );
      }
      return result;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      depth--;
      if (valid) {
        const durationMs = Math.max(0, now() - start);
        const span = {
          phase: captured,
          operation,
          startedMs: start - origin,
          durationMs,
          failed,
        };
        add(sync, captured + "/" + operation, durationMs, failed);
        top(slowestSync, span, (value) => value.durationMs);
        // Nested measurements remain visible individually; only root spans
        // contribute to timer-gap coverage, preventing double-counting.
        if (root) {
          rootSyncMs += durationMs;
          top(syncSinceTick, span, (value) => value.durationMs, 4);
        }
      }
    }
  };
  const measureAsyncElapsed = async <T>(
    operation: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const captured = phase,
      start = now(),
      id = ++sequence;
    activeAsync.set(id, { phase: captured, operation, start });
    let failed = false;
    try {
      return await run();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      activeAsync.delete(id);
      const durationMs = Math.max(0, now() - start);
      add(asyncElapsed, captured + "/" + operation, durationMs, failed);
      const span = {
        phase: captured,
        operation,
        startedMs: start - origin,
        durationMs,
        failed,
      };
      top(slowestAsync, span, (value) => value.durationMs);
      top(asyncSinceTick, span, (value) => value.durationMs, 4);
    }
  };
  const sampleTimer = () => {
    const end = now(),
      durationMs = Math.max(0, end - previousTick);
    const measuredRootSyncWallMs = Math.min(durationMs, rootSyncMs);
    top(
      timerGaps,
      {
        fromPhase: previousPhase,
        toPhase: phase,
        durationMs,
        measuredRootSyncWallMs,
        unmeasuredWallMs: Math.max(0, durationMs - measuredRootSyncWallMs),
        longestMeasuredSyncCalls: [...syncSinceTick],
        longestCompletedAsyncElapsed: [...asyncSinceTick],
        activeAsync: [...activeAsync.values()].slice(0, 4).map((value) => ({
          phase: value.phase,
          operation: value.operation,
          elapsedMs: Math.max(0, end - value.start),
        })),
      },
      (value) => value.durationMs,
    );
    previousTick = end;
    previousPhase = phase;
    rootSyncMs = 0;
    syncSinceTick.length = 0;
    asyncSinceTick.length = 0;
  };
  return {
    setPhase(next: string) {
      phase = next;
    },
    measureSync,
    measureAsyncElapsed,
    /** Only the immediate call entry is synchronous. Any continuation after its
     * first await is excluded; full elapsed remains a separate async metric. */
    measureAsyncEntry<T>(operation: string, run: () => Promise<T>) {
      return measureAsyncElapsed(operation + ".elapsed", () => {
        let pending!: Promise<T>;
        measureSync(operation + ".entry", () => {
          pending = run();
        });
        return pending;
      });
    },
    sampleTimer,
    snapshot() {
      return {
        scope:
          "Synchronous invocation wall time includes native SQL waits and OS scheduling; not pure JS CPU. Measurement bookkeeping adds diagnostic overhead; reportWrite includes snapshot/serialization/file I/O. Async elapsed includes awaits/scheduling and overlaps sync; never interpreted as blocking. Timer unmeasuredWallMs includes the timer interval, awaits, uninstrumented JS and scheduling; it does not prove OS-only delay.",
        synchronousByPhase: Object.fromEntries(
          [...sync].map(([key, values]) => [key, summary(values)]),
        ),
        asyncElapsedByPhase: Object.fromEntries(
          [...asyncElapsed].map(([key, values]) => [key, summary(values)]),
        ),
        slowestSynchronousCalls: [...slowestSync],
        slowestAsyncElapsed: [...slowestAsync],
        largestTimerGaps: [...timerGaps],
      };
    },
  };
}
