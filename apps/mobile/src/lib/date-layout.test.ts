import { expect, test } from "bun:test";
import { parseDate } from "../../../../src/shared/views/date";
import { timelineSpan, moveDates, resizeDate } from "./date-layout";
const day = (s: string) => parseDate(s)!;
test("cross-window tasks are clipped to the visible interval", () => {
  expect(
    timelineSpan(
      day("2026-10-01"),
      day("2026-12-01"),
      day("2026-11-01"),
      day("2026-11-30"),
    ),
  ).toEqual({ left: 0, days: 30, milestone: false });
  expect(
    timelineSpan(day("2026-11-08"), null, day("2026-11-01"), day("2026-11-30")),
  ).toEqual({ left: 7, days: 1, milestone: true });
});
test("whole drag preserves duration and handles leap days in local date space", () => {
  expect(
    moveDates("start", day("2024-02-28"), "end", day("2024-03-01"), 1),
  ).toEqual({ start: "2024-02-29", end: "2024-03-02" });
});
test("resize endpoints cannot cross", () => {
  expect(resizeDate(day("2026-11-02"), day("2026-11-04"), "start", 10)).toBe(
    "2026-11-04",
  );
  expect(resizeDate(day("2026-11-02"), day("2026-11-04"), "end", -10)).toBe(
    "2026-11-02",
  );
});
