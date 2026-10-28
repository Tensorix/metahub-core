import { expect, test } from "bun:test";
import { ToastTimer, toastSwipeDismiss } from "./toast-interaction.ts";

test("distance and flick thresholds work in both directions", () => {
  for (const sign of [-1, 1]) {
    expect(toastSwipeDismiss(sign * 120, 400, 0)).toBe(true);
    expect(toastSwipeDismiss(sign * 119, 400, 0)).toBe(false);
    expect(toastSwipeDismiss(sign * 24, 400, sign * .5)).toBe(true);
    expect(toastSwipeDismiss(sign * 23, 400, sign * 2)).toBe(false);
    expect(toastSwipeDismiss(sign * 40, 400, -sign)).toBe(false);
  }
});

test("overlapping pauses preserve remaining time and stop is final", () => {
  const original = { set: globalThis.setTimeout, clear: globalThis.clearTimeout, now: Date.now };
  let now = 0, seq = 0, fired = 0;
  const jobs = new Map<number, { at: number; run: () => void }>();
  globalThis.setTimeout = ((run: () => void, delay: number) => { const id = ++seq; jobs.set(id, { at: now + delay, run }); return id; }) as any;
  globalThis.clearTimeout = ((id: number) => { jobs.delete(id); }) as any;
  Date.now = () => now;
  const advance = (ms: number) => { now += ms; for (const [id, job] of jobs) if (job.at <= now) { jobs.delete(id); job.run(); } };
  try {
    const timer = new ToastTimer(1000, () => fired++);
    advance(400); timer.pause("hover"); timer.pause("focus");
    advance(5000); timer.pause("hover"); timer.resume("hover");
    advance(5000); expect(fired).toBe(0);
    timer.resume("focus"); timer.resume("focus");
    advance(599); expect(fired).toBe(0);
    advance(1); expect(fired).toBe(1);
    timer.resume("focus"); advance(1000); expect(fired).toBe(1);
    const cancelled = new ToastTimer(100, () => fired++);
    cancelled.pause("drag"); cancelled.stop(); cancelled.resume("drag");
    advance(1000); expect(fired).toBe(1);
  } finally { globalThis.setTimeout = original.set; globalThis.clearTimeout = original.clear; Date.now = original.now; }
});
