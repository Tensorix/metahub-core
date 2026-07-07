import { test, expect } from "bun:test";
import {
  parseDate,
  toISO,
  addDays,
  sameDay,
  daysBetween,
  monthMatrix,
  startOfWeekMon,
  timeAgo,
} from "./date.ts";

test("parseDate handles YYYY-MM-DD and empty", () => {
  const d = parseDate("2026-06-02")!;
  expect(d.getFullYear()).toBe(2026);
  expect(d.getMonth()).toBe(5); // June
  expect(d.getDate()).toBe(2);
  expect(parseDate("")).toBeNull();
  expect(parseDate(null)).toBeNull();
  expect(parseDate("nope")).toBeNull();
});

test("parseDate tolerates datetime strings", () => {
  const d = parseDate("2026-06-02T13:45:00")!;
  expect(toISO(d)).toBe("2026-06-02");
});

test("toISO round-trips parseDate", () => {
  expect(toISO(parseDate("2024-02-29")!)).toBe("2024-02-29"); // leap day
});

test("addDays crosses month and year boundaries", () => {
  expect(toISO(addDays(parseDate("2026-01-31")!, 1))).toBe("2026-02-01");
  expect(toISO(addDays(parseDate("2026-12-31")!, 1))).toBe("2027-01-01");
  expect(toISO(addDays(parseDate("2024-03-01")!, -1))).toBe("2024-02-29"); // leap
});

test("sameDay ignores time differences", () => {
  expect(sameDay(parseDate("2026-06-02T01:00")!, parseDate("2026-06-02T23:00")!)).toBe(true);
  expect(sameDay(parseDate("2026-06-02")!, parseDate("2026-06-03")!)).toBe(false);
});

test("daysBetween counts whole days", () => {
  expect(daysBetween(parseDate("2026-06-02")!, parseDate("2026-06-05")!)).toBe(3);
  expect(daysBetween(parseDate("2026-06-05")!, parseDate("2026-06-02")!)).toBe(-3);
  expect(daysBetween(parseDate("2026-06-02")!, parseDate("2026-06-02")!)).toBe(0);
});

test("startOfWeekMon returns the Monday", () => {
  // 2026-06-02 is a Tuesday → Monday is 2026-06-01
  expect(toISO(startOfWeekMon(parseDate("2026-06-02")!))).toBe("2026-06-01");
  // Sunday 2026-06-07 → Monday 2026-06-01
  expect(toISO(startOfWeekMon(parseDate("2026-06-07")!))).toBe("2026-06-01");
});

test("monthMatrix covers the whole month in Monday-first whole weeks", () => {
  const weeks = monthMatrix(2026, 5); // June 2026
  expect(weeks.length).toBeGreaterThanOrEqual(5);
  expect(weeks.length).toBeLessThanOrEqual(6);
  for (const w of weeks) {
    expect(w.length).toBe(7);
    expect(w[0]!.getDay()).toBe(1); // Monday
  }
  // First row starts on or before June 1; June 1 (Monday) appears.
  const flat = weeks.flat().map(toISO);
  expect(flat).toContain("2026-06-01");
  expect(flat).toContain("2026-06-30");
});

test("timeAgo buckets ms / ISO / Date inputs", () => {
  const now = Date.now();
  expect(timeAgo(now - 5_000)).toBe("刚刚");
  expect(timeAgo(now - 5 * 60_000)).toBe("5 分钟前");
  expect(timeAgo(now - 3 * 3_600_000)).toBe("3 小时前");
  expect(timeAgo(now - 2 * 86_400_000)).toBe("2 天前");
  expect(timeAgo(new Date(now - 90_000).toISOString())).toBe("1 分钟前");
  expect(timeAgo(new Date(now - 30_000))).toBe("刚刚");
  // Beyond 30 days: falls back to a locale date string.
  expect(timeAgo(now - 40 * 86_400_000)).toBe(new Date(now - 40 * 86_400_000).toLocaleDateString());
});
