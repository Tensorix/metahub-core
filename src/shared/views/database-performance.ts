/** Per-runtime durations only: native and Web clocks must never be subtracted. */
export type DatabaseTiming = {
  trace: string;
  runtime: 'native' | 'web';
  stage: string;
  elapsedMs: number;
};

export function createDatabaseTrace(
  trace: string,
  runtime: DatabaseTiming['runtime'],
  emit: (sample: DatabaseTiming) => void,
  now: () => number = () => performance.now(),
) {
  const started = now();
  const marked = new Set<string>();
  return {
    mark(stage: string) {
      if (marked.has(stage)) return;
      marked.add(stage);
      emit({ trace, runtime, stage, elapsedMs: Math.max(0, now() - started) });
    },
  };
}

export function summarizeDatabaseTimings(values: number[]) {
  if (!values.length) return { count: 0, median: null, p95: null, max: null };
  if (values.some(value => !Number.isFinite(value) || value < 0))
    throw new Error('Invalid timing sample');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95: sorted[Math.ceil(sorted.length * .95) - 1]!,
    max: sorted[sorted.length - 1]!,
  };
}
