import { expect, test } from 'bun:test';
import { createDatabaseTrace, summarizeDatabaseTimings } from './database-performance';

test('runtime timing uses a local origin and reports each stage once', () => {
  let now = 500;
  const samples: unknown[] = [];
  const trace = createDatabaseTrace('open-1', 'web', value => samples.push(value), () => now);
  now = 520;
  trace.mark('shell-ready');
  now = 600;
  trace.mark('shell-ready');
  trace.mark('interactive');
  expect(samples).toEqual([
    { trace: 'open-1', runtime: 'web', stage: 'shell-ready', elapsedMs: 20 },
    { trace: 'open-1', runtime: 'web', stage: 'interactive', elapsedMs: 100 },
  ]);
});

test('twenty-run summary uses nearest-rank P95 without modifying raw samples', () => {
  const values = Array.from({ length: 20 }, (_, i) => 20 - i);
  expect(summarizeDatabaseTimings(values)).toEqual({ count: 20, median: 10.5, p95: 19, max: 20 });
  expect(values[0]).toBe(20);
  expect(summarizeDatabaseTimings([])).toEqual({ count: 0, median: null, p95: null, max: null });
  expect(() => summarizeDatabaseTimings([NaN])).toThrow();
});
